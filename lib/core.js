'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const PROTECTED = new Set(['username', 'passwordHash', 'salt', 'password', '_space', 'activeSpace']);
const DEFAULT_DATA = () => ({
  displayName: '', grade: '', xp: 0, checkins: [],
  homework: [], poetry: [], words: [], wrong: [], log: [], createdAt: new Date().toISOString(),
});

let MODE = 'file';
let pg = null;
let fileUsers = {};
let initialized = null;
const memorySessions = new Map();

async function initStore() {
  if (initialized) return initialized;
  initialized = (async () => {
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
      await pg.query(`CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
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
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fileUsers = loadFileUsers();
      MODE = 'file';
      console.log('存储模式: 本地文件', USERS_FILE);
    }
  })();
  return initialized;
}

function loadFileUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}; }
  catch (e) { console.error('读取用户数据失败:', e.message); return {}; }
}
function saveFileUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(fileUsers, null, 2)); }

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
async function putUserData(username, data) {
  const u = await fetchUser(username);
  if (!u) return null;
  await putUser(username, u.passwordHash, u.salt, data);
  return await fetchUser(username);
}

const publicFrom = (data, username) => ({ username, ...data });
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function genSalt() { return crypto.randomBytes(16).toString('hex'); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function genSpaceCode() { return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }

async function createSession(username) {
  const token = genToken();
  if (MODE === 'pg') {
    await pg.query(
      `INSERT INTO sessions(token, username, expires_at)
       VALUES($1,$2,now() + interval '30 days')`,
      [token, username]
    );
  } else {
    memorySessions.set(token, username);
  }
  return token;
}
async function deleteSession(token) {
  if (!token) return;
  if (MODE === 'pg') await pg.query('DELETE FROM sessions WHERE token=$1', [token]);
  else memorySessions.delete(token);
}
async function usernameFromToken(token) {
  if (!token) return null;
  if (MODE === 'pg') {
    const r = await pg.query('SELECT username FROM sessions WHERE token=$1 AND expires_at > now()', [token]);
    return r.rows[0] && r.rows[0].username;
  }
  return memorySessions.get(token) || null;
}

function sendJSON(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(req.body ? JSON.parse(req.body) : {}); }
      catch (e) { return reject(new Error('JSON 解析失败')); }
    }
    let data = ''; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}
function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function authUser(req) {
  const username = await usernameFromToken(getToken(req));
  if (!username) return null;
  return await fetchUser(username);
}

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

async function handleApi(req, res, pathname) {
  await initStore();

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
    const token = await createSession(username);
    return sendJSON(res, 200, { token, user: await publicUser({ username, passwordHash, salt, data }) });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const username = (b.username || '').trim();
    const password = b.password || '';
    const u = await fetchUser(username);
    if (!u || u.passwordHash !== hashPassword(password, u.salt)) return sendJSON(res, 401, { error: '用户名或密码错误' });
    const token = await createSession(username);
    return sendJSON(res, 200, { token, user: await publicUser(u) });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    await deleteSession(getToken(req));
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, { user: await publicUser(u) });
  }

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

  if (pathname === '/api/space/create' && req.method === 'POST') {
    const u = await authUser(req); if (!u) return sendJSON(res, 401, { error: '未登录' });
    const b = await readBody(req);
    const name = (b.name || '').trim() || ((u.data.displayName || u.username) + '的学习空间');
    const code = await createSpace(u.username, name, b.seed || u.data);
    const nextUser = await putUserData(u.username, { ...u.data, activeSpace: code });
    return sendJSON(res, 200, { user: await publicUser(nextUser) });
  }

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

module.exports = { handleApi, initStore };
