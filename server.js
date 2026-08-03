'use strict';
/*
 * 学习台 StudyDeck —— 多用户、数据持久化的 K12 学习管理平台
 * 存储层：有 DATABASE_URL 时用 Supabase/Postgres；否则退回本地文件 data/users.json
 * 仅用 Node 内置模块 + 可选 pg（仅 Postgres 模式需要）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PORT = process.env.PORT || 3000;

// 受保护字段（不可被客户端 sync 覆盖）
const PROTECTED = new Set(['username', 'passwordHash', 'salt', 'password']);
const DEFAULT_DATA = () => ({
  displayName: '', grade: '', xp: 0, checkins: [],
  homework: [], poetry: [], words: [], wrong: [], log: [], createdAt: new Date().toISOString(),
});

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- 存储层 ---------------- */
let MODE = 'file';
let pg = null;
let fileUsers = {};

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Client } = require('pg');
    pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    await pg.query(`CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      data JSONB NOT NULL
    )`);
    MODE = 'pg';
    console.log('存储模式: Postgres (Supabase)');
  } else {
    fileUsers = loadFileUsers();
    MODE = 'file';
    console.log('存储模式: 本地文件', USERS_FILE);
  }
}
function loadFileUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; }
  catch (e) { console.error('读取用户数据失败:', e.message); return {}; }
}
function saveFileUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(fileUsers, null, 2)); }

// 返回统一结构 {username, passwordHash, salt, data} 或 null
async function fetchUser(username) {
  if (MODE === 'pg') {
    const r = await pg.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { username: row.username, passwordHash: row.password_hash, salt: row.salt, data: row.data };
  }
  const u = fileUsers[username];
  if (!u) return null;
  const { passwordHash, salt, ...data } = u;
  return { username, passwordHash, salt, data };
}
async function putUser(username, passwordHash, salt, data) {
  if (MODE === 'pg') {
    await pg.query(
      `INSERT INTO users(username, password_hash, salt, data) VALUES($1,$2,$3,$4)
       ON CONFLICT(username) DO UPDATE SET password_hash=$2, salt=$3, data=$4`,
      [username, passwordHash, salt, data]
    );
  } else {
    fileUsers[username] = { username, passwordHash, salt, ...data };
    saveFileUsers();
  }
}
const publicFrom = (data, username) => ({ username, ...data });

/* ---------------- 账号工具 ---------------- */
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function genSalt() { return crypto.randomBytes(16).toString('hex'); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }

const sessions = new Map(); // token -> username

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; } data += c; });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}
function getToken(req) { const h = req.headers['authorization'] || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }
async function authUser(req) {
  const token = getToken(req); if (!token) return null;
  const username = sessions.get(token); if (!username) return null;
  return await fetchUser(username);
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname) {
  // 注册
  if (pathname === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const username = (b.username || '').trim();
    const password = b.password || '';
    const displayName = (b.displayName || '').trim() || username;
    const grade = (b.grade || '').trim();
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) return sendJSON(res, 400, { error: '用户名需为 2-20 位字母/数字/中文/下划线' });
    if (password.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
    if (await fetchUser(username)) return sendJSON(res, 409, { error: '该用户名已被注册' });
    const salt = genSalt();
    const passwordHash = hashPassword(password, salt);
    const data = DEFAULT_DATA(); data.displayName = displayName; data.grade = grade;
    await putUser(username, passwordHash, salt, data);
    const token = genToken(); sessions.set(token, username);
    return sendJSON(res, 200, { token, user: publicFrom(data, username) });
  }
  // 登录
  if (pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const username = (b.username || '').trim();
    const password = b.password || '';
    const u = await fetchUser(username);
    if (!u || u.passwordHash !== hashPassword(password, u.salt)) return sendJSON(res, 401, { error: '用户名或密码错误' });
    const token = genToken(); sessions.set(token, username);
    return sendJSON(res, 200, { token, user: publicFrom(u.data, username) });
  }
  // 登出
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getToken(req); if (token) sessions.delete(token);
    return sendJSON(res, 200, { ok: true });
  }
  // 拉取当前用户状态
  if (pathname === '/api/state' && req.method === 'GET') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, { user: publicFrom(u.data, u.username) });
  }
  // 同步（客户端上报可变数据，服务端合并保存）
  if (pathname === '/api/sync' && req.method === 'POST') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    const b = await readBody(req);
    const data = { ...u.data };
    for (const k of Object.keys(b)) { if (PROTECTED.has(k)) continue; data[k] = b[k]; }
    await putUser(u.username, u.passwordHash, u.salt, data);
    return sendJSON(res, 200, { user: publicFrom(data, u.username) });
  }
  return sendJSON(res, 404, { error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2',
};
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html); }
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => sendJSON(res, 400, { error: err.message || '请求错误' }));
    return;
  }
  serveStatic(req, res, pathname);
});

initStore()
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`学习台已启动: http://localhost:${PORT} (mode=${MODE})`)))
  .catch((e) => { console.error('存储初始化失败:', e.message); process.exit(1); });
