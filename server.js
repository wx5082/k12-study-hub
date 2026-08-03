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
const HOST = process.env.HOST || '0.0.0.0';

// 受保护字段（不可被客户端 sync 覆盖）
const PROTECTED = new Set(['username', 'passwordHash', 'salt', 'password', '_space', 'activeSpace']);
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
    await pg.query(`CREATE TABLE IF NOT EXISTS spaces(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_username TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pg.query(`CREATE TABLE IF NOT EXISTS space_members(
      code TEXT NOT NULL REFERENCES spaces(code) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(code, username)
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
function genSpaceCode() { return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }

const sessions = new Map(); // token -> username

function cleanClientData(data) {
  const out = { ...(data || {}) };
  for (const k of PROTECTED) delete out[k];
  return out;
}
async function fetchSpaceForUser(username, code) {
  if (MODE !== 'pg' || !code) return null;
  const r = await pg.query(
    `SELECT s.code, s.name, s.owner_username, s.data, m.role
     FROM spaces s
     JOIN space_members m ON m.code=s.code
     WHERE s.code=$1 AND m.username=$2`,
    [code, username]
  );
  return r.rows[0] || null;
}
async function publicUser(u) {
  if (MODE === 'pg' && u.data && u.data.activeSpace) {
    const space = await fetchSpaceForUser(u.username, u.data.activeSpace);
    if (space) {
      return publicFrom({
        ...space.data,
        _space: { code: space.code, name: space.name, role: space.role, owner: space.owner_username },
      }, u.username);
    }
  }
  return publicFrom({ ...u.data, _space: null }, u.username);
}
async function putUserData(username, data) {
  const u = await fetchUser(username);
  if (!u) return null;
  await putUser(username, u.passwordHash, u.salt, data);
  return await fetchUser(username);
}
async function createSpace(username, name, seedData) {
  if (MODE !== 'pg') throw new Error('共享空间需要启用 Supabase/Postgres');
  let code = genSpaceCode();
  for (let i = 0; i < 5; i++) {
    const exists = await pg.query('SELECT code FROM spaces WHERE code=$1', [code]);
    if (!exists.rows.length) break;
    code = genSpaceCode();
  }
  const data = cleanClientData(seedData);
  await pg.query('INSERT INTO spaces(code, name, owner_username, data) VALUES($1,$2,$3,$4)', [code, name, username, data]);
  await pg.query('INSERT INTO space_members(code, username, role) VALUES($1,$2,$3)', [code, username, 'owner']);
  return code;
}

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
    return sendJSON(res, 200, { token, user: await publicUser({ username, passwordHash, salt, data }) });
  }
  // 登录
  if (pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const username = (b.username || '').trim();
    const password = b.password || '';
    const u = await fetchUser(username);
    if (!u || u.passwordHash !== hashPassword(password, u.salt)) return sendJSON(res, 401, { error: '用户名或密码错误' });
    const token = genToken(); sessions.set(token, username);
    return sendJSON(res, 200, { token, user: await publicUser(u) });
  }
  // 登出
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getToken(req); if (token) sessions.delete(token);
    return sendJSON(res, 200, { ok: true });
  }
  // 拉取当前用户状态
  if (pathname === '/api/state' && req.method === 'GET') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, { user: await publicUser(u) });
  }
  // 同步（客户端上报可变数据，服务端合并保存）
  if (pathname === '/api/sync' && req.method === 'POST') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    const b = await readBody(req);
    const activeSpace = MODE === 'pg' ? await fetchSpaceForUser(u.username, u.data && u.data.activeSpace) : null;
    const data = activeSpace ? { ...activeSpace.data } : { ...u.data };
    for (const k of Object.keys(b)) { if (PROTECTED.has(k)) continue; data[k] = b[k]; }
    if (activeSpace) {
      await pg.query('UPDATE spaces SET data=$1 WHERE code=$2', [data, activeSpace.code]);
      return sendJSON(res, 200, { user: await publicUser(u) });
    }
    await putUser(u.username, u.passwordHash, u.salt, data);
    return sendJSON(res, 200, { user: await publicUser({ ...u, data }) });
  }
  // 创建共享学习空间，并把当前账号的数据作为初始数据
  if (pathname === '/api/space/create' && req.method === 'POST') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    const b = await readBody(req);
    const name = (b.name || '').trim() || ((u.data.displayName || u.username) + '的学习空间');
    const seed = b.seed || u.data;
    const code = await createSpace(u.username, name, seed);
    const nextData = { ...u.data, activeSpace: code };
    const nextUser = await putUserData(u.username, nextData);
    return sendJSON(res, 200, { user: await publicUser(nextUser) });
  }
  // 加入共享学习空间
  if (pathname === '/api/space/join' && req.method === 'POST') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    const b = await readBody(req);
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return sendJSON(res, 400, { error: '共享码格式不正确' });
    if (MODE !== 'pg') return sendJSON(res, 400, { error: '共享空间需要启用 Supabase/Postgres' });
    const space = await pg.query('SELECT code FROM spaces WHERE code=$1', [code]);
    if (!space.rows.length) return sendJSON(res, 404, { error: '共享空间不存在' });
    await pg.query(
      `INSERT INTO space_members(code, username, role) VALUES($1,$2,$3)
       ON CONFLICT(code, username) DO NOTHING`,
      [code, u.username, 'member']
    );
    const nextUser = await putUserData(u.username, { ...u.data, activeSpace: code });
    return sendJSON(res, 200, { user: await publicUser(nextUser) });
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
  .then(() => server.listen(PORT, HOST, () => console.log(`学习台已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (mode=${MODE})`)))
  .catch((e) => { console.error('存储初始化失败:', e.message); process.exit(1); });
