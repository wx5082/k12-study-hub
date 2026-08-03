'use strict';
/* 学习台 StudyDeck —— 前端逻辑 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let state = { token: null, user: null };
let revealed = new Set();      // 复习中已翻看答案的 id
let rvFilter = 'all';          // 复习页筛选
let pendingSubtasks = [];      // 作业登记时的临时步骤

/* ---------------- 工具 ---------------- */
function fmt(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function today() { return fmt(new Date()); }
function addDaysStr(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
function mondayOf(s) { const d = new Date(s + 'T00:00:00'); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return fmt(d); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------- 接口 ---------------- */
async function api(path, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (state.token) opt.headers['Authorization'] = 'Bearer ' + state.token;
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}
const SYNC_FIELDS = ['displayName', 'grade', 'xp', 'checkins', 'homework', 'poetry', 'words', 'wrong', 'log'];
async function sync() {
  const payload = {};
  SYNC_FIELDS.forEach(f => payload[f] = state.user[f]);
  const r = await api('/api/sync', 'POST', payload);
  state.user = r.user;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function award(xp, type, detail) {
  state.user.xp = (state.user.xp || 0) + xp;
  state.user.log = state.user.log || [];
  state.user.log.push({ date: today(), type, detail, xp });
}

/* ---------------- 派生数据 ---------------- */
const POETRY_IV = [1, 3, 7];
const WORD_IV = [1, 3, 7];
const WRONG_IV = [1, 3, 7, 15];

function isDue(it) { return it.status !== 'mastered' && it.next && it.next <= today(); }
function dueItems() {
  const u = state.user; const out = [];
  (u.poetry || []).forEach(it => { if (isDue(it)) out.push({ ...it, kind: 'poetry' }); });
  (u.words || []).forEach(it => { if (isDue(it)) out.push({ ...it, kind: 'words' }); });
  (u.wrong || []).forEach(it => { if (isDue(it)) out.push({ ...it, kind: 'wrong' }); });
  return out;
}
function computeStreak(checkins) {
  const set = new Set(checkins || []);
  let d = new Date();
  if (!set.has(fmt(d))) d.setDate(d.getDate() - 1);
  let s = 0;
  while (set.has(fmt(d))) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
function levelInfo(xp) {
  const level = Math.floor((xp || 0) / 100) + 1;
  const base = (level - 1) * 100;
  const within = (xp || 0) - base;
  return { level, within, next: level * 100, pct: Math.min(100, Math.round(within / 100 * 100)) };
}
function masteryInfo() {
  const u = state.user;
  const all = [...(u.poetry || []), ...(u.words || []), ...(u.wrong || [])];
  if (!all.length) return { pct: 0, mastered: 0, total: 0 };
  const mastered = all.filter(x => x.status === 'mastered').length;
  return { pct: Math.round(mastered / all.length * 100), mastered, total: all.length };
}
function statusPill(it) {
  if (it.status === 'mastered') return '<span class="pill master">已掌握</span>';
  if (isDue(it)) return '<span class="pill due">今天复习</span>';
  const dd = daysBetween(today(), it.next);
  if (dd <= 2) return '<span class="pill soon">' + dd + ' 天后</span>';
  return '<span class="pill ok">第 ' + (it.stage + 1) + ' 次 · ' + it.next + '</span>';
}
function stageLabel(it) {
  return it.status === 'mastered' ? '已掌握' : ('第 ' + (it.stage + 1) + '/' + it.intervals.length + ' 次');
}

/* ---------------- 渲染：总览 ---------------- */
function renderOverview() {
  const u = state.user;
  const lv = levelInfo(u.xp);
  $('#ov-level').textContent = 'Lv.' + lv.level;
  $('#ov-streak').textContent = computeStreak(u.checkins) + '🔥';
  const m = masteryInfo();
  $('#ov-master').textContent = m.pct + '%';
  $('#ov-xp').textContent = u.xp || 0;
  $('#ov-xp-next').textContent = lv.next;
  $('#ov-xp-bar').style.width = lv.pct + '%';
  $('#ov-xp-label').textContent = '距 Lv.' + (lv.level + 1);

  const due = dueItems();
  $('#ov-due').textContent = '今日待复习：' + due.length;

  // 今日复习队列（概览）
  const box = $('#ov-due-list');
  if (!due.length) { box.innerHTML = '<div class="empty">今天没有待复习的内容，去加一点吧 🎉</div>'; }
  else {
    box.innerHTML = due.slice(0, 6).map(it => {
      const title = it.kind === 'poetry' ? it.title : it.kind === 'words' ? it.word : it.subject;
      return `<div class="item review-card"><div class="top"><span class="title">${esc(title)}</span>
        <span class="meta">${it.kind === 'poetry' ? '古诗文' : it.kind === 'words' ? '单词' : '错题'}</span></div></div>`;
    }).join('');
  }
  // 导航红点
  const badge = $('#nav-review-badge');
  if (due.length) { badge.textContent = due.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

/* ---------------- 渲染：作业 ---------------- */
function renderHomework() {
  const u = state.user;
  const list = $('#hw-list');
  const items = (u.homework || []).slice().sort((a, b) => (a.done === b.done ? (a.due || '').localeCompare(b.due || '') : a.done ? 1 : -1));
  if (!items.length) { list.innerHTML = '<div class="empty">还没有登记作业。</div>'; return; }
  list.innerHTML = items.map(h => {
    const overdue = !h.done && h.due && h.due < today();
    const dueToday = !h.done && h.due === today();
    let dueTag = '';
    if (h.done) dueTag = '<span class="pill ok">已完成</span>';
    else if (overdue) dueTag = '<span class="pill due">已逾期 ' + h.due + '</span>';
    else if (dueToday) dueTag = '<span class="pill soon">今天截止</span>';
    else if (h.due) dueTag = '<span class="pill ok">截止 ' + h.due + '</span>';
    const tasks = (h.tasks || []).map(t => `<div class="subtask-list"><div class="st" style="margin:0">
      <input type="checkbox" ${t.done ? 'checked' : ''} data-action="hw-task" data-id="${h.id}" data-tid="${t.id}" />
      <span style="${t.done ? 'text-decoration:line-through;color:var(--txt-dim)' : ''}">${esc(t.text)}</span></div></div>`).join('');
    return `<div class="item ${h.done ? 'done' : ''}">
      <div class="top"><span class="title">${esc(h.title)}</span>
        <span class="meta">${esc(h.subject || '')}</span> ${dueTag}</div>
      ${tasks}
      <div class="actions">
        <button class="btn sm" data-action="hw-done" data-id="${h.id}">${h.done ? '↩ 标记未完成' : '✔ 完成'}</button>
        <button class="btn ghost sm danger" data-action="hw-del" data-id="${h.id}">删除</button>
      </div></div>`;
  }).join('');
}

/* ---------------- 渲染：古诗文 / 单词 / 错题 ---------------- */
function renderPoetry() {
  const list = $('#po-list');
  const items = (state.user.poetry || []);
  if (!items.length) { list.innerHTML = '<div class="empty">还没有加入古诗文。</div>'; return; }
  list.innerHTML = items.map(p => `<div class="item ${p.status === 'mastered' ? 'done' : ''}">
    <div class="top"><span class="title">${esc(p.title)}</span><span class="meta">${esc(p.author || '')}</span> ${statusPill(p)}</div>
    <div class="body">${esc(p.content)}</div>
    <div class="actions"><span class="tag">${stageLabel(p)}</span>
      <button class="btn ghost sm danger" data-action="po-del" data-id="${p.id}">删除</button></div></div>`).join('');
}
function renderWords() {
  const list = $('#wd-list');
  const items = (state.user.words || []);
  if (!items.length) { list.innerHTML = '<div class="empty">还没有加入单词。</div>'; return; }
  list.innerHTML = items.map(w => `<div class="item ${w.status === 'mastered' ? 'done' : ''}">
    <div class="top"><span class="title">${esc(w.word)}</span><span class="meta">${esc(w.mean || '')}</span> ${statusPill(w)}</div>
    <div class="actions"><span class="tag">${stageLabel(w)}</span>
      <button class="btn ghost sm danger" data-action="wd-del" data-id="${w.id}">删除</button></div></div>`).join('');
}
function renderWrong() {
  const list = $('#wq-list');
  const items = (state.user.wrong || []);
  if (!items.length) { list.innerHTML = '<div class="empty">还没有记录错题。</div>'; return; }
  list.innerHTML = items.map(q => `<div class="item ${q.status === 'mastered' ? 'done' : ''}">
    <div class="top"><span class="title">${esc(q.subject || '错题')}</span> ${statusPill(q)}</div>
    <div class="body">❓ ${esc(q.question)}</div>
    <div class="body">✏️ 我的：${esc(q.mine)}</div>
    <div class="body">✅ 正确：${esc(q.correct)}</div>
    <div class="actions"><span class="tag">${stageLabel(q)}</span>
      <button class="btn ghost sm danger" data-action="wq-del" data-id="${q.id}">删除</button></div></div>`).join('');
}

/* ---------------- 渲染：复习 ---------------- */
function renderReview() {
  const due = dueItems();
  let items = due;
  if (rvFilter !== 'all') items = due.filter(x => x.kind === rvFilter);
  const list = $('#rv-list');
  if (!items.length) { list.innerHTML = '<div class="empty">这一分类今天没有待复习的内容 🎉</div>'; return; }
  list.innerHTML = items.map(it => {
    const rev = revealed.has(it.id);
    let q, a = '';
    if (it.kind === 'poetry') { q = it.title + (it.author ? '（' + it.author + '）' : ''); a = it.content; }
    else if (it.kind === 'words') { q = it.word; a = it.mean; }
    else { q = it.question; a = '我的：' + it.mine + '\n正确：' + it.correct; }
    const kindName = it.kind === 'poetry' ? '古诗文' : it.kind === 'words' ? '单词' : '错题';
    return `<div class="item review-card">
      <div class="top"><span class="title">${esc(q)}</span><span class="meta">${kindName} · 第 ${it.stage + 1} 次</span></div>
      ${rev ? `<div class="reveal"><div class="ans">${esc(a)}</div>
        <div class="actions" style="margin-top:10px">
          <button class="btn sm" data-action="rv-ok" data-type="${it.kind}" data-id="${it.id}">✅ 记住了 (+5)</button>
          <button class="btn ghost sm" data-action="rv-no" data-type="${it.kind}" data-id="${it.id}">😣 忘了 (+2)</button>
        </div></div>`
        : `<button class="btn ghost sm flip-btn" data-action="rv-flip" data-type="${it.kind}" data-id="${it.id}">👀 看答案 / 自测</button>`}
    </div>`;
  }).join('');
}

/* ---------------- 渲染：战报 ---------------- */
function renderReport() {
  const u = state.user;
  const ws = mondayOf(today());
  const log = (u.log || []).filter(l => l.date >= ws);
  const homeworkDone = log.filter(l => l.type === 'hw').length;
  const reviews = log.filter(l => l.type === 'review').length;
  const masters = log.filter(l => l.type === 'master').length;
  const checkinDays = new Set((u.checkins || []).filter(d => d >= ws)).size;
  const xpWeek = log.reduce((s, l) => s + (l.xp || 0), 0);

  $('#rp-week').textContent = '本周（' + ws + ' 起）';
  $('#rp-grid').innerHTML = `
    <div class="stat"><div class="v">${homeworkDone}</div><div class="l">完成作业</div></div>
    <div class="stat"><div class="v">${reviews}</div><div class="l">复习次数</div></div>
    <div class="stat"><div class="v">${masters}</div><div class="l">新掌握</div></div>
    <div class="stat"><div class="v">${checkinDays}🔥</div><div class="l">打卡天数</div></div>
    <div class="stat"><div class="v">${xpWeek}</div><div class="l">本周经验</div></div>
    <div class="stat"><div class="v">${computeStreak(u.checkins)}🔥</div><div class="l">连续打卡</div></div>`;

  const recent = (u.log || []).slice(-12).reverse();
  $('#rp-log').innerHTML = recent.length ? recent.map(l => {
    const name = { hw: '完成作业', review: '复习', master: '掌握一项', checkin: '打卡', add: '新增' }[l.type] || l.type;
    return `<div class="item" style="margin-bottom:8px"><div class="top"><span class="title">${esc(name)}</span>
      <span class="meta">${l.date} · +${l.xp || 0} XP</span></div>
      ${l.detail ? `<div class="body">${esc(l.detail)}</div>` : ''}</div>`;
  }).join('') : '<div class="empty">还没有动态。</div>';
}

/* ---------------- 总渲染 ---------------- */
function renderAll() {
  if (!state.user) return;
  $('#ui-name').textContent = state.user.displayName || state.user.username;
  $('#ui-grade').textContent = state.user.grade || '未填年级';
  $('#ui-avatar').textContent = (state.user.displayName || state.user.username || '?').slice(0, 1);
  renderOverview();
  renderHomework();
  renderPoetry();
  renderWords();
  renderWrong();
  renderReview();
  renderReport();
}

/* ---------------- 增删改操作 ---------------- */
function addReviewItem(arr, item, label) {
  state.user[arr] = state.user[arr] || [];
  state.user[arr].push(item);
  award(2, 'add', label);
}
function doReview(kind, id, remembered) {
  const map = { poetry: 'poetry', words: 'words', wrong: 'wrong' };
  const arr = state.user[map[kind]];
  const it = arr.find(x => x.id === id);
  if (!it) return;
  if (remembered) {
    it.stage += 1;
    if (it.stage >= it.intervals.length) { it.status = 'mastered'; it.next = null; award(10, 'master', stageLabel(it)); toast('🎉 已掌握！+10'); }
    else { it.next = addDaysStr(today(), it.intervals[it.stage]); award(5, 'review', '记住了'); toast('✅ 记住了 +5'); }
  } else {
    it.stage = 0; it.next = addDaysStr(today(), it.intervals[0]); award(2, 'review', '忘了'); toast('😣 回到第 1 天 +2');
  }
  it.last = today();
  revealed.delete(id);
  sync().then(renderAll);
}

/* ---------------- 事件绑定 ---------------- */
// 复习页筛选
$$('#nav button[data-rv]').forEach(b => b.addEventListener('click', () => {
  $$('#nav button[data-rv]').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); rvFilter = b.dataset.rv; renderReview();
}));

// 顶部导航切换
$$('#nav button[data-tab]').forEach(b => b.addEventListener('click', () => {
  $$('#nav button[data-tab]').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $$('.section').forEach(s => s.classList.remove('active'));
  $(`.section[data-section="${b.dataset.tab}"]`).classList.add('active');
}));

// 作业：临时步骤
$('#hw-add-sub').addEventListener('click', addSubtask);
$('#hw-subtask').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } });
function addSubtask() {
  const v = $('#hw-subtask').value.trim();
  if (!v) return;
  pendingSubtasks.push({ id: uid(), text: v, done: false });
  $('#hw-subtask').value = '';
  renderPendingSubtasks();
}
function renderPendingSubtasks() {
  $('#hw-subtask-list').innerHTML = pendingSubtasks.map(t =>
    `<div class="st"><span>${esc(t.text)}</span><span class="x" data-st="${t.id}">✕</span></div>`).join('');
  $$('#hw-subtask-list .x').forEach(x => x.addEventListener('click', () => {
    pendingSubtasks = pendingSubtasks.filter(t => t.id !== x.dataset.st); renderPendingSubtasks();
  }));
}
$('#hw-save').addEventListener('click', () => {
  const subject = $('#hw-subject').value.trim();
  const title = $('#hw-title').value.trim();
  const due = $('#hw-due').value;
  if (!title) { toast('请填写作业内容'); return; }
  state.user.homework = state.user.homework || [];
  state.user.homework.push({ id: uid(), subject, title, due, done: false, tasks: pendingSubtasks.slice() });
  award(2, 'add', title);
  pendingSubtasks = [];
  $('#hw-subject').value = ''; $('#hw-title').value = ''; $('#hw-due').value = '';
  renderPendingSubtasks();
  sync().then(() => { renderAll(); toast('已登记作业'); });
});

// 古诗文
$('#po-save').addEventListener('click', () => {
  const title = $('#po-title').value.trim();
  const content = $('#po-content').value.trim();
  if (!title || !content) { toast('请填写篇名和原文'); return; }
  addReviewItem('poetry', { id: uid(), title, author: $('#po-author').value.trim(), content, added: today(), intervals: POETRY_IV, stage: 0, last: null, next: addDaysStr(today(), POETRY_IV[0]), status: 'learning' }, title);
  $('#po-title').value = ''; $('#po-author').value = ''; $('#po-content').value = '';
  sync().then(() => { renderAll(); toast('已加入古诗文复习'); });
});
// 单词
$('#wd-save').addEventListener('click', () => {
  const word = $('#wd-word').value.trim();
  const mean = $('#wd-mean').value.trim();
  if (!word || !mean) { toast('请填写单词和释义'); return; }
  addReviewItem('words', { id: uid(), word, mean, added: today(), intervals: WORD_IV, stage: 0, last: null, next: addDaysStr(today(), WORD_IV[0]), status: 'learning' }, word);
  $('#wd-word').value = ''; $('#wd-mean').value = '';
  sync().then(() => { renderAll(); toast('已加入单词复习'); });
});
// 错题
$('#wq-save').addEventListener('click', () => {
  const subject = $('#wq-subject').value.trim();
  const question = $('#wq-question').value.trim();
  const correct = $('#wq-correct').value.trim();
  if (!question) { toast('请填写题目'); return; }
  addReviewItem('wrong', { id: uid(), subject, question, mine: $('#wq-mine').value.trim(), correct, added: today(), intervals: WRONG_IV, stage: 0, last: null, next: addDaysStr(today(), WRONG_IV[0]), status: 'learning' }, subject || '错题');
  $('#wq-subject').value = ''; $('#wq-question').value = ''; $('#wq-mine').value = ''; $('#wq-correct').value = '';
  sync().then(() => { renderAll(); toast('已加入错题本'); });
});

// 打卡
$('#btn-checkin').addEventListener('click', () => {
  const t = today();
  state.user.checkins = state.user.checkins || [];
  if (state.user.checkins.includes(t)) { toast('今天已经打卡啦 🔥'); return; }
  state.user.checkins.push(t);
  award(10, 'checkin', '每日打卡');
  sync().then(() => { renderAll(); toast('打卡成功 +10 🔥'); });
});

// 退出
$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST'); } catch (e) {}
  state = { token: null, user: null };
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
});

// 列表内事件委托
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const id = t.dataset.id;
  if (a === 'hw-done') {
    const h = state.user.homework.find(x => x.id === id);
    if (!h) return;
    h.done = !h.done;
    if (h.done) award(15, 'hw', h.title);
    sync().then(renderAll);
  } else if (a === 'hw-task') {
    // checkbox 变化在 change 事件处理更稳，这里仅兜底
  } else if (a === 'hw-del') {
    state.user.homework = state.user.homework.filter(x => x.id !== id);
    sync().then(renderAll);
  } else if (a === 'po-del') {
    state.user.poetry = state.user.poetry.filter(x => x.id !== id); sync().then(renderAll);
  } else if (a === 'wd-del') {
    state.user.words = state.user.words.filter(x => x.id !== id); sync().then(renderAll);
  } else if (a === 'wq-del') {
    state.user.wrong = state.user.wrong.filter(x => x.id !== id); sync().then(renderAll);
  } else if (a === 'rv-flip') {
    revealed.add(id); renderReview();
  } else if (a === 'rv-ok') {
    doReview(t.dataset.type, id, true);
  } else if (a === 'rv-no') {
    doReview(t.dataset.type, id, false);
  }
});
// 作业子步骤勾选
document.addEventListener('change', e => {
  const t = e.target.closest('[data-action="hw-task"]');
  if (!t) return;
  const h = state.user.homework.find(x => x.id === t.dataset.id);
  if (!h) return;
  const st = (h.tasks || []).find(x => x.id === t.dataset.tid);
  if (!st) return;
  st.done = t.checked;
  if (st.done) { award(3, 'hw', '完成步骤'); toast('+3'); }
  sync().then(renderAll);
});

/* ---------------- 登录 / 注册 ---------------- */
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('#au-submit').textContent = m === 'login' ? '登录' : '注册';
  $('#au-toggle-text').textContent = m === 'login' ? '还没有账号？' : '已有账号？';
  $('#au-toggle').textContent = m === 'login' ? '去注册' : '去登录';
  $('#au-extra').style.display = m === 'login' ? 'none' : 'block';
  $('#au-err').textContent = '';
}
$('#au-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#au-username').value.trim();
  const password = $('#au-password').value;
  $('#au-err').textContent = '';
  try {
    let r;
    if (authMode === 'login') r = await api('/api/login', 'POST', { username, password });
    else r = await api('/api/register', 'POST', { username, password, displayName: $('#au-display').value.trim(), grade: $('#au-grade').value.trim() });
    state.token = r.token; state.user = r.user;
    $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
    renderAll();
  } catch (err) { $('#au-err').textContent = err.message; }
});

// 启动：尝试恢复已有会话（刷新后保持登录由浏览器决定，这里默认重新登录）
setAuthMode('login');
