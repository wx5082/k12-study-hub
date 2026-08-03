'use strict';
/* 学习台 StudyDeck —— 前端逻辑 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let state = { token: null, authUser: null, user: null };
let revealed = new Set();      // 复习中已翻看答案的 id
let rvFilter = 'all';          // 复习页筛选
let pendingSubtasks = [];      // 作业登记时的临时步骤
let refreshTimer = null;       // 多端同步轮询
const SUPABASE_CONFIG = window.K12_SUPABASE || {};
const db = window.supabase && SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey
  ? window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey)
  : null;

/* ---------------- 工具 ---------------- */
function fmt(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function today() { return fmt(new Date()); }
function addDaysStr(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
function mondayOf(s) { const d = new Date(s + 'T00:00:00'); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return fmt(d); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------- Supabase 数据层 ---------------- */
function ensureDb() {
  if (!db) throw new Error('Supabase 未配置，请检查 GitHub Actions Secrets：SUPABASE_URL / SUPABASE_ANON_KEY，并重新运行 Pages 部署');
}
const SUBJECTS = ['语文', '数学', '英语'];
const SUBJECT_KEYS = { '语文': 'chinese', '数学': 'math', '英语': 'english' };
const SYNC_FIELDS = ['displayName', 'grade', 'xp', 'money', 'rewardConfig', 'checkins', 'homework', 'poetry', 'words', 'wrong', 'log'];
const DEFAULT_DATA = () => ({
  displayName: '', grade: '', xp: 0, money: 0,
  rewardConfig: {
    '语文': { reward: 2, penalty: 1 },
    '数学': { reward: 2, penalty: 1 },
    '英语': { reward: 2, penalty: 1 },
  },
  checkins: [],
  homework: [], poetry: [], words: [], wrong: [], log: [], createdAt: new Date().toISOString(),
});
function clientData(data) {
  const out = {};
  SYNC_FIELDS.forEach(f => out[f] = data && data[f] != null ? data[f] : DEFAULT_DATA()[f]);
  out.createdAt = data && data.createdAt ? data.createdAt : new Date().toISOString();
  return out;
}
function publicFrom(profile, data, space) {
  return {
    username: profile.email,
    displayName: data.displayName || profile.display_name || profile.email,
    grade: data.grade || profile.grade || '',
    xp: data.xp || 0,
    money: data.money || 0,
    rewardConfig: normalizeRewardConfig(data.rewardConfig),
    checkins: data.checkins || [],
    homework: data.homework || [],
    poetry: data.poetry || [],
    words: data.words || [],
    wrong: data.wrong || [],
    log: data.log || [],
    createdAt: data.createdAt || profile.created_at || new Date().toISOString(),
    _space: space || null,
  };
}
function normalizeRewardConfig(cfg) {
  const defaults = DEFAULT_DATA().rewardConfig;
  const out = {};
  SUBJECTS.forEach(s => {
    out[s] = {
      reward: Number(cfg && cfg[s] && cfg[s].reward != null ? cfg[s].reward : defaults[s].reward),
      penalty: Number(cfg && cfg[s] && cfg[s].penalty != null ? cfg[s].penalty : defaults[s].penalty),
    };
  });
  return out;
}
async function ensureProfile(authUser, meta = {}) {
  let { data: profile, error } = await db.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
  if (error) throw error;
  if (profile) return profile;
  const base = DEFAULT_DATA();
  base.displayName = meta.displayName || authUser.email;
  base.grade = meta.grade || '';
  const insert = {
    id: authUser.id,
    email: authUser.email,
    display_name: base.displayName,
    grade: base.grade,
    data: base,
  };
  const r = await db.from('profiles').insert(insert).select('*').single();
  if (r.error) throw r.error;
  return r.data;
}
async function loadCurrentUser() {
  ensureDb();
  const sessionResult = await db.auth.getSession();
  const session = sessionResult.data && sessionResult.data.session;
  if (!session) return null;
  state.authUser = session.user;
  state.token = session.access_token;
  const profile = await ensureProfile(session.user);
  let activeSpace = null;
  let data = profile.data || DEFAULT_DATA();
  if (profile.active_space) {
    const r = await db.from('spaces').select('code,name,owner_id,data,space_members!inner(role)').eq('code', profile.active_space).eq('space_members.user_id', session.user.id).maybeSingle();
    if (!r.error && r.data) {
      activeSpace = { code: r.data.code, name: r.data.name, role: r.data.space_members[0].role, owner: r.data.owner_id };
      data = r.data.data || DEFAULT_DATA();
    }
  }
  state.user = publicFrom(profile, data, activeSpace);
  return state.user;
}
async function sync() {
  const payload = {};
  SYNC_FIELDS.forEach(f => payload[f] = state.user[f]);
  if (state.user._space) {
    const { error } = await db.from('spaces').update({ data: clientData(payload), updated_at: new Date().toISOString() }).eq('code', state.user._space.code);
    if (error) throw error;
  } else {
    const { error } = await db.from('profiles').update({
      display_name: payload.displayName,
      grade: payload.grade,
      data: clientData(payload),
      updated_at: new Date().toISOString(),
    }).eq('id', state.authUser.id);
    if (error) throw error;
  }
  await loadCurrentUser();
}
async function refreshState(silent = true) {
  if (!state.authUser) return;
  try {
    await loadCurrentUser();
    renderAll();
    if (!silent) toast('已同步最新数据');
  } catch (e) {
    if (!silent) toast(e.message);
  }
}
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => refreshState(true), 10000);
}
function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
function genSpaceCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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
  const items = state.user.homework || [];
  if (!items.length) return { pct: 0, mastered: 0, total: 0 };
  const completed = items.filter(x => homeworkStatus(x) === 'completed').length;
  return { pct: Math.round(completed / items.length * 100), mastered: completed, total: items.length };
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
  $('#ov-streak').textContent = '¥' + Number(u.money || 0).toFixed(2).replace(/\.00$/, '');
  const m = masteryInfo();
  $('#ov-master').textContent = m.pct + '%';
  $('#ov-xp').textContent = u.xp || 0;
  $('#ov-xp-next').textContent = lv.next;
  $('#ov-xp-bar').style.width = lv.pct + '%';
  $('#ov-xp-label').textContent = '距 Lv.' + (lv.level + 1);

  const todayPending = (u.homework || []).filter(h => homeworkStatus(h) === 'pending' && (!h.due || h.due <= today()));
  $('#ov-due').textContent = '今日待完成作业：' + todayPending.length;

  const box = $('#ov-due-list');
  if (!todayPending.length) { box.innerHTML = '<div class="empty">今天没有待处理作业。</div>'; }
  else {
    box.innerHTML = todayPending.slice(0, 8).map(h => {
      return `<div class="item review-card"><div class="top"><span class="title">${esc(h.title)}</span>
        <span class="meta">${esc(h.subject || '作业')} · ${h.due || '未设日期'}</span></div></div>`;
    }).join('');
  }
}

function homeworkStatus(h) {
  if (h.status) return h.status;
  return h.done ? 'completed' : 'pending';
}
function subjectConfig(subject) {
  return (state.user.rewardConfig && state.user.rewardConfig[subject]) || { reward: 0, penalty: 0 };
}
function moneyText(n) {
  const v = Number(n || 0);
  return (v >= 0 ? '+¥' : '-¥') + Math.abs(v).toFixed(2).replace(/\.00$/, '');
}
function homeworkStats(subject) {
  const items = (state.user.homework || []).filter(h => !subject || h.subject === subject);
  const completed = items.filter(h => homeworkStatus(h) === 'completed').length;
  const missed = items.filter(h => homeworkStatus(h) === 'missed').length;
  const pending = items.filter(h => homeworkStatus(h) === 'pending').length;
  const money = items.reduce((sum, h) => sum + Number(h.moneyApplied || 0), 0);
  return { total: items.length, completed, missed, pending, money };
}
function renderStatsBox(selector, subject) {
  const box = $(selector);
  if (!box) return;
  const s = homeworkStats(subject);
  const label = subject || '全部';
  box.innerHTML = `
    <div class="stat"><div class="v">${s.total}</div><div class="l">${label}作业</div></div>
    <div class="stat"><div class="v master">${s.completed}</div><div class="l">已完成</div></div>
    <div class="stat"><div class="v flame">${s.pending}</div><div class="l">待处理</div></div>
    <div class="stat"><div class="v">${moneyText(s.money)}</div><div class="l">奖惩合计</div></div>`;
}

/* ---------------- 渲染：作业 ---------------- */
function renderHomeworkList(selector, subject) {
  const list = $(selector);
  if (!list) return;
  const items = (state.user.homework || [])
    .filter(h => !subject || h.subject === subject)
    .slice()
    .sort((a, b) => {
      const sa = homeworkStatus(a), sb = homeworkStatus(b);
      return sa === sb ? (a.due || '').localeCompare(b.due || '') : sa === 'pending' ? -1 : sb === 'pending' ? 1 : 0;
    });
  if (!items.length) { list.innerHTML = '<div class="empty">还没有登记作业。</div>'; return; }
  list.innerHTML = items.map(h => {
    const status = homeworkStatus(h);
    const overdue = status === 'pending' && h.due && h.due < today();
    const dueToday = status === 'pending' && h.due === today();
    const cfg = subjectConfig(h.subject);
    let dueTag = '';
    if (status === 'completed') dueTag = '<span class="pill ok">已完成 ' + moneyText(h.moneyApplied || cfg.reward) + '</span>';
    else if (status === 'missed') dueTag = '<span class="pill due">未完成 ' + moneyText(h.moneyApplied || -cfg.penalty) + '</span>';
    else if (overdue) dueTag = '<span class="pill due">已逾期 ' + h.due + '</span>';
    else if (dueToday) dueTag = '<span class="pill soon">今天截止</span>';
    else if (h.due) dueTag = '<span class="pill ok">截止 ' + h.due + '</span>';
    const tasks = (h.tasks || []).map(t => `<div class="subtask-list"><div class="st" style="margin:0">
      <input type="checkbox" ${t.done ? 'checked' : ''} data-action="hw-task" data-id="${h.id}" data-tid="${t.id}" />
      <span style="${t.done ? 'text-decoration:line-through;color:var(--txt-dim)' : ''}">${esc(t.text)}</span></div></div>`).join('');
    return `<div class="item ${status !== 'pending' ? 'done' : ''}">
      <div class="top"><span class="title">${esc(h.title)}</span>
        <span class="meta">${esc(h.subject || '')}</span> ${dueTag}</div>
      ${tasks}
      <div class="actions">
        <button class="btn sm" data-action="hw-complete" data-id="${h.id}" ${status === 'completed' ? 'disabled' : ''}>完成</button>
        <button class="btn ghost sm danger" data-action="hw-miss" data-id="${h.id}" ${status === 'missed' ? 'disabled' : ''}>未完成</button>
        <button class="btn ghost sm" data-action="hw-pending" data-id="${h.id}" ${status === 'pending' ? 'disabled' : ''}>恢复待处理</button>
        <button class="btn ghost sm danger" data-action="hw-del" data-id="${h.id}">删除</button>
      </div></div>`;
  }).join('');
}
function renderRewardSettings() {
  const box = $('#reward-settings');
  if (!box) return;
  const cfg = normalizeRewardConfig(state.user.rewardConfig);
  box.innerHTML = SUBJECTS.map(s => `<div style="min-width:180px">
    <label>${s} 完成奖励</label><input type="number" min="0" step="0.5" data-reward="${s}" value="${cfg[s].reward}" />
    <label style="margin-top:6px">${s} 未完成扣款</label><input type="number" min="0" step="0.5" data-penalty="${s}" value="${cfg[s].penalty}" />
  </div>`).join('');
}
function renderHomework() {
  renderRewardSettings();
  renderStatsBox('#hw-stats', null);
  renderStatsBox('#hw-stats-chinese', '语文');
  renderStatsBox('#hw-stats-math', '数学');
  renderStatsBox('#hw-stats-english', '英语');
  renderHomeworkList('#hw-list', null);
  renderHomeworkList('#hw-list-chinese', '语文');
  renderHomeworkList('#hw-list-math', '数学');
  renderHomeworkList('#hw-list-english', '英语');
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
  const homeworkMissed = log.filter(l => l.type === 'hw_miss').length;
  const rewardWeek = log
    .filter(l => l.type === 'hw' || l.type === 'hw_miss')
    .reduce((s, l) => {
      const m = String(l.detail || '').match(/([+-])¥([0-9.]+)/);
      if (!m) return s;
      return s + (m[1] === '-' ? -1 : 1) * Number(m[2]);
    }, 0);
  const checkinDays = new Set((u.checkins || []).filter(d => d >= ws)).size;
  const xpWeek = log.reduce((s, l) => s + (l.xp || 0), 0);

  $('#rp-week').textContent = '本周（' + ws + ' 起）';
  $('#rp-grid').innerHTML = `
    <div class="stat"><div class="v">${homeworkDone}</div><div class="l">完成作业</div></div>
    <div class="stat"><div class="v">${homeworkMissed}</div><div class="l">未完成作业</div></div>
    <div class="stat"><div class="v">${moneyText(rewardWeek)}</div><div class="l">本周奖惩</div></div>
    <div class="stat"><div class="v">${checkinDays}🔥</div><div class="l">打卡天数</div></div>
    <div class="stat"><div class="v">${xpWeek}</div><div class="l">本周经验</div></div>
    <div class="stat"><div class="v">¥${Number(u.money || 0).toFixed(2).replace(/\.00$/, '')}</div><div class="l">奖励余额</div></div>`;

  const recent = (u.log || []).slice(-12).reverse();
  $('#rp-log').innerHTML = recent.length ? recent.map(l => {
    const name = { hw: '完成作业', hw_miss: '未完成作业', hw_pending: '恢复待处理', review: '复习', master: '掌握一项', checkin: '打卡', add: '新增' }[l.type] || l.type;
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
  renderSpace();
  renderOverview();
  renderHomework();
  renderReport();
}

function renderSpace() {
  const sp = state.user._space;
  const status = $('#sp-status');
  const current = $('#sp-current');
  if (!status || !current) return;
  if (sp) {
    status.textContent = '当前空间：' + sp.name + '。把共享码给其他账号，对方登录后输入即可共同更新这份学习数据。';
    current.textContent = '共享码：' + sp.code;
    current.classList.remove('hidden');
    $('#sp-name').value = sp.name;
  } else {
    status.textContent = '当前为个人数据。创建共享空间后，多个账号可用同一个共享码共同更新这份学习数据。';
    current.classList.add('hidden');
  }
}

/* ---------------- 增删改操作 ---------------- */
function addReviewItem(arr, item, label) {
  state.user[arr] = state.user[arr] || [];
  state.user[arr].push(item);
  award(2, 'add', label);
}
function settleHomework(h, nextStatus) {
  const prevAmount = Number(h.moneyApplied || 0);
  let nextAmount = 0;
  const cfg = subjectConfig(h.subject);
  if (nextStatus === 'completed') nextAmount = Number(cfg.reward || 0);
  if (nextStatus === 'missed') nextAmount = -Number(cfg.penalty || 0);

  state.user.money = Number(state.user.money || 0) - prevAmount + nextAmount;
  h.status = nextStatus;
  h.done = nextStatus === 'completed';
  h.moneyApplied = nextAmount;
  h.settledAt = nextStatus === 'pending' ? null : new Date().toISOString();
  h.updatedAt = new Date().toISOString();

  if (nextStatus === 'completed') {
    award(15, 'hw', `${h.subject}：${h.title} 完成 ${moneyText(nextAmount)}`);
  } else if (nextStatus === 'missed') {
    award(0, 'hw_miss', `${h.subject}：${h.title} 未完成 ${moneyText(nextAmount)}`);
  } else {
    state.user.log = state.user.log || [];
    state.user.log.push({ date: today(), type: 'hw_pending', detail: `${h.subject}：${h.title} 恢复待处理`, xp: 0 });
  }
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
  const subject = SUBJECTS.includes($('#hw-subject').value) ? $('#hw-subject').value : '语文';
  const title = $('#hw-title').value.trim();
  const due = $('#hw-due').value;
  if (!title) { toast('请填写作业内容'); return; }
  state.user.homework = state.user.homework || [];
  state.user.homework.push({ id: uid(), subject, title, due, status: 'pending', done: false, moneyApplied: 0, tasks: pendingSubtasks.slice(), createdAt: new Date().toISOString() });
  award(2, 'add', title);
  pendingSubtasks = [];
  $('#hw-subject').value = '语文'; $('#hw-title').value = ''; $('#hw-due').value = '';
  renderPendingSubtasks();
  sync().then(() => { renderAll(); toast('已登记作业'); });
});

$('#reward-save').addEventListener('click', () => {
  const cfg = normalizeRewardConfig(state.user.rewardConfig);
  SUBJECTS.forEach(s => {
    const reward = Number(($(`[data-reward="${s}"]`) || {}).value || 0);
    const penalty = Number(($(`[data-penalty="${s}"]`) || {}).value || 0);
    cfg[s] = { reward: Math.max(0, reward), penalty: Math.max(0, penalty) };
  });
  state.user.rewardConfig = cfg;
  sync().then(() => { renderAll(); toast('奖励设置已保存'); });
});

// 旧复习模块入口保留兼容，不在当前界面显示
if ($('#po-save')) $('#po-save').addEventListener('click', () => {
  const title = $('#po-title').value.trim();
  const content = $('#po-content').value.trim();
  if (!title || !content) { toast('请填写篇名和原文'); return; }
  addReviewItem('poetry', { id: uid(), title, author: $('#po-author').value.trim(), content, added: today(), intervals: POETRY_IV, stage: 0, last: null, next: addDaysStr(today(), POETRY_IV[0]), status: 'learning' }, title);
  $('#po-title').value = ''; $('#po-author').value = ''; $('#po-content').value = '';
  sync().then(() => { renderAll(); toast('已加入古诗文复习'); });
});
if ($('#wd-save')) $('#wd-save').addEventListener('click', () => {
  const word = $('#wd-word').value.trim();
  const mean = $('#wd-mean').value.trim();
  if (!word || !mean) { toast('请填写单词和释义'); return; }
  addReviewItem('words', { id: uid(), word, mean, added: today(), intervals: WORD_IV, stage: 0, last: null, next: addDaysStr(today(), WORD_IV[0]), status: 'learning' }, word);
  $('#wd-word').value = ''; $('#wd-mean').value = '';
  sync().then(() => { renderAll(); toast('已加入单词复习'); });
});
if ($('#wq-save')) $('#wq-save').addEventListener('click', () => {
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

// 共享空间
$('#sp-create').addEventListener('click', async () => {
  const name = $('#sp-name').value.trim() || ((state.user.displayName || state.user.username) + '的学习空间');
  try {
    let code = genSpaceCode();
    for (let i = 0; i < 5; i++) {
      const exists = await db.from('spaces').select('code').eq('code', code).maybeSingle();
      if (!exists.data) break;
      code = genSpaceCode();
    }
    const seed = clientData(state.user);
    const created = await db.from('spaces').insert({ code, name, owner_id: state.authUser.id, data: seed }).select('code').single();
    if (created.error) throw created.error;
    const member = await db.from('space_members').insert({ code, user_id: state.authUser.id, role: 'owner' });
    if (member.error) throw member.error;
    const profile = await db.from('profiles').update({ active_space: code }).eq('id', state.authUser.id);
    if (profile.error) throw profile.error;
    await loadCurrentUser();
    renderAll();
    toast('共享空间已创建');
  } catch (e) { toast(e.message); }
});
$('#sp-join').addEventListener('click', async () => {
  const code = $('#sp-code').value.trim().toUpperCase();
  if (!code) { toast('请输入共享码'); return; }
  try {
    const joined = await db.rpc('join_space', { join_code: code });
    if (joined.error) throw joined.error;
    const profile = await db.from('profiles').update({ active_space: code }).eq('id', state.authUser.id);
    if (profile.error) throw profile.error;
    await loadCurrentUser();
    $('#sp-code').value = '';
    renderAll();
    toast('已加入共享空间');
  } catch (e) { toast(e.message); }
});

// 退出
$('#btn-logout').addEventListener('click', async () => {
  try { await db.auth.signOut(); } catch (e) {}
  stopRefresh();
  state = { token: null, authUser: null, user: null };
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
});

// 列表内事件委托
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  const id = t.dataset.id;
  if (a === 'hw-complete' || a === 'hw-miss' || a === 'hw-pending') {
    const h = state.user.homework.find(x => x.id === id);
    if (!h) return;
    const nextStatus = a === 'hw-complete' ? 'completed' : a === 'hw-miss' ? 'missed' : 'pending';
    settleHomework(h, nextStatus);
    sync().then(() => { renderAll(); toast(nextStatus === 'completed' ? '已完成，奖励已入账' : nextStatus === 'missed' ? '已标记未完成，扣款已记录' : '已恢复待处理'); });
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
  const email = $('#au-username').value.trim();
  const password = $('#au-password').value;
  $('#au-err').textContent = '';
  try {
    ensureDb();
    let r;
    if (authMode === 'login') {
      r = await db.auth.signInWithPassword({ email, password });
    } else {
      r = await db.auth.signUp({
        email,
        password,
        options: { data: { displayName: $('#au-display').value.trim(), grade: $('#au-grade').value.trim() } },
      });
    }
    if (r.error) throw r.error;
    if (!r.data.session) throw new Error('注册成功，请先到邮箱完成确认，或在 Supabase Auth 里关闭 Confirm email 后再登录');
    state.authUser = r.data.user;
    state.token = r.data.session.access_token;
    await ensureProfile(r.data.user, { displayName: $('#au-display').value.trim(), grade: $('#au-grade').value.trim() });
    await loadCurrentUser();
    $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
    renderAll();
    startRefresh();
  } catch (err) { $('#au-err').textContent = err.message; }
});

// 启动：恢复 Supabase 浏览器会话
setAuthMode('login');
loadCurrentUser().then(user => {
  if (!user) return;
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  renderAll();
  startRefresh();
}).catch(err => {
  $('#au-err').textContent = err.message;
});
