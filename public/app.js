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
function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return fmt(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
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
const SYNC_FIELDS = ['displayName', 'grade', 'xp', 'points', 'money', 'rewardPaid', 'rewardConfig', 'rewardItems', 'rewardRedemptions', 'checkins', 'homework', 'poetry', 'words', 'wrong', 'log'];
const DEFAULT_DATA = () => ({
  displayName: '', grade: '', xp: 0, points: 0, money: 0, rewardPaid: 0,
  rewardConfig: {
    '语文': { reward: 2, penalty: 1 },
    '数学': { reward: 2, penalty: 1 },
    '英语': { reward: 2, penalty: 1 },
  },
  rewardItems: DEFAULT_REWARD_ITEMS(),
  rewardRedemptions: [],
  checkins: [],
  homework: [], poetry: [], words: [], wrong: [], log: [], createdAt: new Date().toISOString(),
});
function DEFAULT_REWARD_ITEMS() {
  return [
    { id: 'default-screen-20', name: '额外娱乐 20 分钟', cost: 80, active: true },
    { id: 'default-dinner', name: '选择一次家庭晚餐', cost: 150, active: true },
    { id: 'default-gift', name: '小文具 / 小礼物一次', cost: 300, active: true },
  ];
}
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
    points: data.points != null ? Number(data.points || 0) : Number(data.xp || 0),
    money: data.money || 0,
    rewardPaid: data.rewardPaid || 0,
    rewardConfig: normalizeRewardConfig(data.rewardConfig),
    rewardItems: normalizeRewardItems(data.rewardItems),
    rewardRedemptions: data.rewardRedemptions || [],
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
function normalizeRewardItems(items) {
  const list = Array.isArray(items) && items.length ? items : DEFAULT_REWARD_ITEMS();
  return list.map(item => ({
    id: item.id || uid(),
    name: item.name || '未命名奖励',
    cost: Math.max(1, Number(item.cost || 1)),
    active: item.active !== false,
  }));
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
    if (!silent) toast(friendlyError(e));
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
function friendlyError(err) {
  const msg = err && err.message ? err.message : String(err || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return '无法连接 Supabase，请换网络或浏览器后重试；如果是在微信/QQ内打开，请复制链接到 Safari/Chrome。';
  }
  return msg;
}
function award(xp, type, detail) {
  state.user.xp = (state.user.xp || 0) + xp;
  state.user.points = Number(state.user.points || 0) + xp;
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
function isOverdueHomework(h) {
  return homeworkStatus(h) === 'pending' && h.due && h.due < today();
}
function subjectConfig(subject) {
  return (state.user.rewardConfig && state.user.rewardConfig[subject]) || { reward: 0, penalty: 0 };
}
function moneyText(n) {
  const v = Number(n || 0);
  return (v >= 0 ? '+¥' : '-¥') + Math.abs(v).toFixed(2).replace(/\.00$/, '');
}
function canOverrideHomework() {
  return !state.user._space || state.user._space.role === 'owner';
}
function homeworkAssignedDate(h) {
  if (h.assignedDate) return h.assignedDate;
  if (h.createdAt) return fmt(new Date(h.createdAt));
  return h.due || today();
}
function homeworkStats(subject, options = {}) {
  const items = (state.user.homework || [])
    .filter(h => !subject || h.subject === subject)
    .filter(h => !options.dueDate || h.due === options.dueDate)
    .filter(h => !options.futureDue || (h.due && h.due > today()))
    .filter(h => {
      if (!options.dueStart && !options.dueEnd) return true;
      const d = h.due || '';
      if (options.dueStart && d < options.dueStart) return false;
      if (options.dueEnd && d > options.dueEnd) return false;
      return true;
    })
    .filter(h => {
      if (!options.start && !options.end) return true;
      const d = homeworkAssignedDate(h);
      if (options.start && d < options.start) return false;
      if (options.end && d > options.end) return false;
      return true;
    });
  const completed = items.filter(h => homeworkStatus(h) === 'completed').length;
  const missed = items.filter(h => homeworkStatus(h) === 'missed').length;
  const pending = items.filter(h => homeworkStatus(h) === 'pending').length;
  const money = items.reduce((sum, h) => sum + Number(h.moneyApplied || 0), 0);
  return { total: items.length, completed, missed, pending, money };
}
function renderStatsBox(selector, subject, options = {}) {
  const box = $(selector);
  if (!box) return;
  const s = homeworkStats(subject, options);
  const label = subject || '全部';
  box.innerHTML = `
    <div class="stat"><div class="v">${s.total}</div><div class="l">${label}作业</div></div>
    <div class="stat"><div class="v master">${s.completed}</div><div class="l">已完成</div></div>
    <div class="stat"><div class="v flame">${s.pending}</div><div class="l">待处理</div></div>
    <div class="stat"><div class="v">${moneyText(s.money)}</div><div class="l">奖惩合计</div></div>`;
}

/* ---------------- 渲染：作业 ---------------- */
function renderHomeworkList(selector, subject, options = {}) {
  const list = $(selector);
  if (!list) return;
  const showActions = options.showActions !== false;
  const showDelete = options.showDelete === true;
  const items = (state.user.homework || [])
    .filter(h => !subject || h.subject === subject)
    .filter(h => !options.dueDate || h.due === options.dueDate)
    .filter(h => !options.futureDue || (h.due && h.due > today()))
    .filter(h => {
      if (!options.dueStart && !options.dueEnd) return true;
      const d = h.due || '';
      if (options.dueStart && d < options.dueStart) return false;
      if (options.dueEnd && d > options.dueEnd) return false;
      return true;
    })
    .filter(h => !options.assignedDate || homeworkAssignedDate(h) === options.assignedDate)
    .slice()
    .sort((a, b) => {
      const sa = homeworkStatus(a), sb = homeworkStatus(b);
      return sa === sb ? (a.due || '').localeCompare(b.due || '') : sa === 'pending' ? -1 : sb === 'pending' ? 1 : 0;
    });
  if (!items.length) { list.innerHTML = `<div class="empty">${options.emptyText || '还没有登记作业。'}</div>`; return; }
  list.innerHTML = items.map(h => {
    const status = homeworkStatus(h);
    const overdue = isOverdueHomework(h);
    const dueToday = status === 'pending' && h.due === today();
    const cfg = subjectConfig(h.subject);
    let dueTag = '';
    if (status === 'completed') dueTag = '<span class="pill ok">已完成 ' + moneyText(h.moneyApplied || cfg.reward) + '</span>';
    else if (status === 'missed') dueTag = '<span class="pill due">未完成 ' + moneyText(h.moneyApplied || -cfg.penalty) + '</span>';
    else if (overdue) dueTag = '<span class="pill due">已逾期 ' + h.due + '</span>';
    else if (dueToday) dueTag = '<span class="pill soon">今天截止</span>';
    else if (h.due) dueTag = '<span class="pill ok">截止 ' + h.due + '</span>';
    const doneTime = status === 'completed' && h.completedAt ? `<div class="body">完成时间：${esc(fmtTime(h.completedAt))}</div>` : '';
    const assignedLine = `<div class="body">布置日期：${esc(homeworkAssignedDate(h))}${h.due ? ' · 截止日期：' + esc(h.due) : ''}</div>`;
    const tasks = (h.tasks || []).map(t => `<div class="subtask-list"><div class="st" style="margin:0">
      <input type="checkbox" ${t.done ? 'checked' : ''} data-action="hw-task" data-id="${h.id}" data-tid="${t.id}" />
      <span style="${t.done ? 'text-decoration:line-through;color:var(--txt-dim)' : ''}">${esc(t.text)}</span></div></div>`).join('');
    const locked = overdue ? 'disabled title="逾期作业不可再改状态"' : '';
    const actionButtons = showActions ? `<button class="btn sm ${status === 'completed' ? 'success active-state' : ''}" data-action="hw-complete" data-id="${h.id}" ${status === 'completed' || overdue ? 'disabled' : ''} ${locked}>完成</button>
        <button class="btn sm danger-fill ${status === 'missed' ? 'active-state' : ''}" data-action="hw-miss" data-id="${h.id}" ${status === 'missed' || overdue ? 'disabled' : ''} ${locked}>未完成</button>
        <button class="btn ghost sm ${status === 'pending' ? 'active-state' : ''}" data-action="hw-pending" data-id="${h.id}" ${status === 'pending' || overdue ? 'disabled' : ''} ${locked}>${overdue ? '逾期锁定' : '待处理'}</button>` : '';
    const deleteDisabled = showDelete && overdue;
    const deleteButton = showDelete ? `<button class="btn ghost sm danger" data-action="hw-del" data-id="${h.id}" ${deleteDisabled ? 'disabled title="逾期未处理作业不可删除"' : ''}>${deleteDisabled ? '逾期不可删' : '删除'}</button>` : '';
    const lastAudit = (h.auditLog || []).slice(-1)[0];
    const auditLine = lastAudit ? `<div class="body">最近特殊管理：${esc(lastAudit.action)} · ${esc(lastAudit.reason)} · ${esc(fmtTime(lastAudit.at))}</div>` : '';
    const overridePanel = options.adminManage && overdue ? renderOverridePanel(h) : '';
    return `<div class="item ${status !== 'pending' ? 'done' : ''}">
      <div class="top"><span class="title">${esc(h.title)}</span>
        <span class="meta">${esc(h.subject || '')}</span> ${dueTag}</div>
      ${assignedLine}
      ${doneTime}
      ${auditLine}
      ${tasks}
      <div class="actions">
        ${actionButtons}
        ${deleteButton}
      </div>
      ${overridePanel}</div>`;
  }).join('');
}
function renderOverridePanel(h) {
  if (!canOverrideHomework()) return '<div class="override-box"><div class="body">逾期作业已锁定，仅空间创建者可特殊管理。</div></div>';
  return `<div class="override-box">
    <div class="override-title">特殊管理</div>
    <div class="form-row">
      <div style="flex:1;min-width:180px"><label>原因</label><input data-override-reason="${h.id}" placeholder="如：老师延期 / 误登记 / 请假补录" /></div>
      <div style="min-width:150px"><label>新截止日期</label><input data-override-due="${h.id}" type="date" value="${esc(h.due || today())}" /></div>
      <div style="min-width:140px"><label>状态</label>
        <select data-override-status="${h.id}">
          <option value="pending">待处理</option>
          <option value="completed">完成</option>
          <option value="missed">未完成</option>
        </select>
      </div>
    </div>
    <div class="actions">
      <button class="btn ghost sm" data-action="hw-override-due" data-id="${h.id}">修改截止</button>
      <button class="btn sm" data-action="hw-override-status" data-id="${h.id}">修改状态</button>
      <button class="btn ghost sm danger" data-action="hw-override-delete" data-id="${h.id}">强制删除</button>
    </div>
  </div>`;
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
function renderRewardPayout() {
  const stats = $('#reward-payout-stats');
  const input = $('#reward-paid');
  if (!stats || !input) return;
  const total = Number(state.user.money || 0);
  const paid = Number(state.user.rewardPaid || 0);
  const pending = total - paid;
  input.value = paid;
  stats.innerHTML = `
    <div class="stat"><div class="v">¥${total.toFixed(2).replace(/\.00$/, '')}</div><div class="l">累计奖励</div></div>
    <div class="stat"><div class="v">¥${paid.toFixed(2).replace(/\.00$/, '')}</div><div class="l">已发放</div></div>
    <div class="stat"><div class="v">${moneyText(pending)}</div><div class="l">待发放</div></div>`;
}
function renderSubjectHomework(subject) {
  const key = SUBJECT_KEYS[subject];
  renderStatsBox(`#hw-stats-${key}`, subject, { dueDate: today() });
  renderHomeworkList(`#hw-upcoming-${key}`, subject, {
    futureDue: true,
    emptyText: `暂无未到截止日期的${subject}作业。`,
  });
  const start = $(`#hw-range-start-${key}`) && $(`#hw-range-start-${key}`).value;
  const end = $(`#hw-range-end-${key}`) && $(`#hw-range-end-${key}`).value;
  if (!start && !end) {
    const list = $(`#hw-list-${key}`);
    if (list) list.innerHTML = '<div class="empty">选择开始或结束日期后展示对应时间段的作业。</div>';
    return;
  }
  renderHomeworkList(`#hw-list-${key}`, subject, {
    dueStart: start,
    dueEnd: end,
    emptyText: '这个时间段没有对应作业。',
  });
}
function renderRewardCenter() {
  const stats = $('#points-stats');
  const guide = $('#reward-guide');
  const store = $('#reward-store');
  const records = $('#reward-redemptions');
  if (!stats || !store || !records) return;
  state.user.rewardItems = normalizeRewardItems(state.user.rewardItems);
  state.user.rewardRedemptions = state.user.rewardRedemptions || [];
  const lv = levelInfo(state.user.xp);
  const pending = state.user.rewardRedemptions.filter(x => x.status === 'pending').length;
  const fulfilled = state.user.rewardRedemptions.filter(x => x.status === 'fulfilled').length;
  stats.innerHTML = `
    <div class="stat"><div class="v lvl">Lv.${lv.level}</div><div class="l">当前等级</div></div>
    <div class="stat"><div class="v">${state.user.xp || 0}</div><div class="l">累计经验</div></div>
    <div class="stat"><div class="v flame">${state.user.points || 0}</div><div class="l">可用积分</div></div>
    <div class="stat"><div class="v master">${pending}</div><div class="l">待发放</div></div>
    <div class="stat"><div class="v">${fulfilled}</div><div class="l">已发放</div></div>`;
  if (guide) {
    const cfg = normalizeRewardConfig(state.user.rewardConfig);
    const rewardText = SUBJECTS.map(s => `${s}完成 ${moneyText(cfg[s].reward)}，未完成 ${moneyText(-cfg[s].penalty)}`).join('；');
    guide.innerHTML = `
      <div class="guide-card">
        <div class="guide-title">经验值用来做什么</div>
        <p>累计经验不被消耗，用来升级和保留长期成长记录。当前是 Lv.${lv.level}，距离 Lv.${lv.level + 1} 还差 ${Math.max(0, lv.next - Number(state.user.xp || 0))} 经验。</p>
      </div>
      <div class="guide-card">
        <div class="guide-title">可用积分怎么来</div>
        <p>每日打卡 +10，登记作业 +2，完成作业 +15，完成小步骤 +3。获得经验时会同步增加可用积分。</p>
      </div>
      <div class="guide-card">
        <div class="guide-title">积分怎么消耗</div>
        <p>在积分商店兑换家庭权益，只扣可用积分，不影响等级。兑换后进入待发放，由家长确认发放或取消返还。</p>
      </div>
      <div class="guide-card">
        <div class="guide-title">作业奖罚逻辑</div>
        <p>${esc(rewardText)}。未完成只扣奖励金，不扣经验和积分；逾期作业会锁定，需要管理页特殊处理并填写原因。</p>
      </div>
      <div class="guide-card">
        <div class="guide-title">建议使用方式</div>
        <p>日常看积分，阶段看等级，周末统一处理兑换和奖励金发放。这样孩子能看到进步，家长也能控制真实支出。</p>
      </div>`;
  }

  const activeItems = state.user.rewardItems.filter(x => x.active !== false);
  if (!activeItems.length) {
    store.innerHTML = '<div class="empty">还没有可兑换奖励。</div>';
  } else {
    store.innerHTML = activeItems.map(item => {
      const enough = Number(state.user.points || 0) >= Number(item.cost || 0);
      return `<div class="reward-item">
        <div>
          <div class="reward-name">${esc(item.name)}</div>
          <div class="body">${item.cost} 积分 · ${enough ? '可以兑换' : '积分不足'}</div>
        </div>
        <div class="actions">
          <button class="btn sm" data-action="reward-redeem" data-id="${item.id}" ${enough ? '' : 'disabled'}>兑换</button>
          <button class="btn ghost sm danger" data-action="reward-item-del" data-id="${item.id}" ${canOverrideHomework() ? '' : 'disabled title="仅空间创建者可管理奖励"'}>删除</button>
        </div>
      </div>`;
    }).join('');
  }

  const list = state.user.rewardRedemptions.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!list.length) {
    records.innerHTML = '<div class="empty">还没有兑换记录。</div>';
  } else {
    records.innerHTML = list.map(r => {
      const statusText = r.status === 'fulfilled' ? '已发放' : r.status === 'canceled' ? '已取消' : '待发放';
      const pillClass = r.status === 'fulfilled' ? 'ok' : r.status === 'canceled' ? 'due' : 'soon';
      const adminActions = r.status === 'pending' && canOverrideHomework() ? `<button class="btn sm" data-action="reward-fulfill" data-id="${r.id}">标记发放</button>
        <button class="btn ghost sm danger" data-action="reward-cancel" data-id="${r.id}">取消并返还</button>` : '';
      return `<div class="item">
        <div class="top"><span class="title">${esc(r.name)}</span><span class="pill ${pillClass}">${statusText}</span></div>
        <div class="body">${r.cost} 积分 · 兑换时间：${esc(fmtTime(r.createdAt))}${r.handledAt ? ' · 处理时间：' + esc(fmtTime(r.handledAt)) : ''}</div>
        <div class="actions">${adminActions || '<span class="tag">记录已归档</span>'}</div>
      </div>`;
    }).join('');
  }
  const addBtn = $('#reward-item-add');
  if (addBtn) addBtn.disabled = !canOverrideHomework();
  const nameInput = $('#reward-item-name');
  const costInput = $('#reward-item-cost');
  if (nameInput) nameInput.disabled = !canOverrideHomework();
  if (costInput) costInput.disabled = !canOverrideHomework();
}
function renderHomework() {
  renderRewardSettings();
  renderRewardPayout();
  renderStatsBox('#hw-stats', null, { dueDate: today() });
  renderSubjectHomework('语文');
  renderSubjectHomework('数学');
  renderSubjectHomework('英语');
  renderStatsBox('#hw-stats-manage', null);
  renderHomeworkList('#hw-today-list', null, { dueDate: today(), emptyText: '今天没有截止作业。' });
  renderHomeworkList('#hw-date-list', null, { assignedDate: ($('#hw-date-filter') && $('#hw-date-filter').value) || today(), emptyText: '这一天没有登记作业。' });
  renderHomeworkList('#hw-list-manage', null, { showActions: false, showDelete: true, adminManage: true });
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
  const start = ($('#rp-start') && $('#rp-start').value) || mondayOf(today());
  const end = ($('#rp-end') && $('#rp-end').value) || today();
  $('#rp-week').textContent = `${start} 至 ${end}，按布置日期统计`;
  const groups = [null, ...SUBJECTS];
  $('#rp-grid').innerHTML = groups.map(subject => {
    const s = homeworkStats(subject, { start, end });
    const name = subject || '全部';
    const rate = s.total ? Math.round(s.completed / s.total * 100) : 0;
    return `<div class="stat report-subject">
      <div class="subject-name">${name}</div>
      <div class="mini-grid">
        <span><b>${s.total}</b><em>总数</em></span>
        <span><b>${s.completed}</b><em>完成</em></span>
        <span><b>${s.missed}</b><em>未完成</em></span>
        <span><b>${s.pending}</b><em>待处理</em></span>
      </div>
      <div class="body">完成率 ${rate}% · 奖惩 ${moneyText(s.money)}</div>
    </div>`;
  }).join('');
}

/* ---------------- 总渲染 ---------------- */
function renderAll() {
  if (!state.user) return;
  $('#ui-name').textContent = state.user.displayName || state.user.username;
  $('#ui-grade').textContent = state.user.grade || '未填年级';
  $('#ui-avatar').textContent = (state.user.displayName || state.user.username || '?').slice(0, 1);
  ensureHomeworkDefaults();
  renderSpace();
  renderOverview();
  renderHomework();
  renderRewardCenter();
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
function ensureHomeworkDefaults() {
  const due = $('#hw-due');
  if (due && !due.value) due.value = today();
  const filter = $('#hw-date-filter');
  if (filter && !filter.value) filter.value = today();
  const rpStart = $('#rp-start');
  const rpEnd = $('#rp-end');
  if (rpStart && !rpStart.value) rpStart.value = mondayOf(today());
  if (rpEnd && !rpEnd.value) rpEnd.value = today();
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
  h.completedAt = nextStatus === 'completed' ? new Date().toISOString() : null;
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
function auditHomework(h, action, reason, extra = {}) {
  const entry = { action, reason, at: new Date().toISOString(), operator: state.user.username, ...extra };
  h.auditLog = h.auditLog || [];
  h.auditLog.push(entry);
  state.user.log = state.user.log || [];
  state.user.log.push({ date: today(), type: 'admin_override', detail: `${h.subject || '作业'}：${h.title} · ${action} · ${reason}`, xp: 0 });
}
function overrideReason(id) {
  const el = $(`[data-override-reason="${id}"]`);
  const reason = el ? el.value.trim() : '';
  if (!reason) toast('请填写特殊管理原因');
  return reason;
}
function forceDeleteHomework(id, reason) {
  const h = state.user.homework.find(x => x.id === id);
  if (!h) return false;
  auditHomework(h, '强制删除', reason);
  const amount = Number(h.moneyApplied || 0);
  if (amount) state.user.money = Number(state.user.money || 0) - amount;
  state.user.homework = state.user.homework.filter(x => x.id !== id);
  return true;
}
function deleteHomework(id) {
  const h = state.user.homework.find(x => x.id === id);
  if (!h) return false;
  if (isOverdueHomework(h)) {
    toast('逾期未处理作业不可删除');
    return false;
  }
  const amount = Number(h.moneyApplied || 0);
  if (amount) state.user.money = Number(state.user.money || 0) - amount;
  state.user.homework = state.user.homework.filter(x => x.id !== id);
  state.user.log = state.user.log || [];
  state.user.log.push({ date: today(), type: 'hw_delete', detail: `${h.subject || '作业'}：${h.title} 已删除`, xp: 0 });
  return true;
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
  const due = $('#hw-due').value || today();
  if (!title) { toast('请填写作业内容'); return; }
  state.user.homework = state.user.homework || [];
  state.user.homework.push({ id: uid(), subject, title, due, assignedDate: today(), status: 'pending', done: false, moneyApplied: 0, tasks: pendingSubtasks.slice(), createdAt: new Date().toISOString() });
  award(2, 'add', title);
  pendingSubtasks = [];
  $('#hw-subject').value = '语文'; $('#hw-title').value = ''; $('#hw-due').value = today();
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

$('#reward-paid-save').addEventListener('click', () => {
  const paid = Number($('#reward-paid').value || 0);
  state.user.rewardPaid = Math.max(0, paid);
  state.user.log = state.user.log || [];
  state.user.log.push({ date: today(), type: 'reward_paid', detail: `已发放奖励 ¥${state.user.rewardPaid.toFixed(2).replace(/\.00$/, '')}`, xp: 0 });
  sync().then(() => { renderAll(); toast('已保存发放金额'); });
});

$('#reward-item-add').addEventListener('click', () => {
  if (!canOverrideHomework()) { toast('仅空间创建者可管理奖励'); return; }
  const name = $('#reward-item-name').value.trim();
  const cost = Math.round(Number($('#reward-item-cost').value || 0));
  if (!name) { toast('请填写奖励名称'); return; }
  if (cost < 1) { toast('积分至少为 1'); return; }
  state.user.rewardItems = normalizeRewardItems(state.user.rewardItems);
  state.user.rewardItems.push({ id: uid(), name, cost, active: true });
  state.user.log = state.user.log || [];
  state.user.log.push({ date: today(), type: 'reward_item_add', detail: `新增奖励：${name}（${cost} 积分）`, xp: 0 });
  $('#reward-item-name').value = '';
  $('#reward-item-cost').value = 100;
  sync().then(() => { renderAll(); toast('奖励已新增'); });
});

$('#hw-date-filter').addEventListener('change', () => renderHomework());
$$('[id^="hw-range-start-"], [id^="hw-range-end-"]').forEach(input => input.addEventListener('change', () => renderHomework()));
$('#rp-start').addEventListener('change', () => renderReport());
$('#rp-end').addEventListener('change', () => renderReport());

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
    let created = null;
    for (let i = 0; i < 5; i++) {
      const result = await db.rpc('create_space', { space_code: code, space_name: name, seed_data: clientData(state.user) });
      if (!result.error) { created = result.data || code; break; }
      if (result.error.code !== '23505') throw result.error;
      code = genSpaceCode();
    }
    if (!created) throw new Error('共享码生成失败，请再试一次');
    await loadCurrentUser();
    renderAll();
    toast('共享空间已创建');
  } catch (e) { toast(friendlyError(e)); }
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
  } catch (e) { toast(friendlyError(e)); }
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
    if (isOverdueHomework(h)) { toast('逾期作业不可再改状态'); return; }
    const nextStatus = a === 'hw-complete' ? 'completed' : a === 'hw-miss' ? 'missed' : 'pending';
    settleHomework(h, nextStatus);
    sync().then(() => { renderAll(); toast(nextStatus === 'completed' ? '已完成，奖励已入账' : nextStatus === 'missed' ? '已标记未完成，扣款已记录' : '已恢复待处理'); });
  } else if (a === 'hw-task') {
    // checkbox 变化在 change 事件处理更稳，这里仅兜底
  } else if (a === 'hw-del') {
    if (deleteHomework(id)) sync().then(() => { renderAll(); toast('作业已删除'); });
  } else if (a === 'hw-override-due') {
    const h = state.user.homework.find(x => x.id === id);
    if (!h || !canOverrideHomework()) return;
    const reason = overrideReason(id); if (!reason) return;
    const dueEl = $(`[data-override-due="${id}"]`);
    const nextDue = dueEl && dueEl.value;
    if (!nextDue) { toast('请选择新截止日期'); return; }
    const oldDue = h.due;
    h.due = nextDue;
    h.updatedAt = new Date().toISOString();
    auditHomework(h, '修改截止日期', reason, { from: oldDue, to: nextDue });
    sync().then(() => { renderAll(); toast('截止日期已修改'); });
  } else if (a === 'hw-override-status') {
    const h = state.user.homework.find(x => x.id === id);
    if (!h || !canOverrideHomework()) return;
    const reason = overrideReason(id); if (!reason) return;
    const statusEl = $(`[data-override-status="${id}"]`);
    const nextStatus = statusEl && statusEl.value;
    if (!['pending', 'completed', 'missed'].includes(nextStatus)) return;
    const oldStatus = homeworkStatus(h);
    settleHomework(h, nextStatus);
    auditHomework(h, '修改状态', reason, { from: oldStatus, to: nextStatus });
    sync().then(() => { renderAll(); toast('状态已特殊调整'); });
  } else if (a === 'hw-override-delete') {
    const h = state.user.homework.find(x => x.id === id);
    if (!h || !canOverrideHomework()) return;
    const reason = overrideReason(id); if (!reason) return;
    if (forceDeleteHomework(id, reason)) sync().then(() => { renderAll(); toast('作业已强制删除'); });
  } else if (a === 'reward-redeem') {
    state.user.rewardItems = normalizeRewardItems(state.user.rewardItems);
    const item = state.user.rewardItems.find(x => x.id === id && x.active !== false);
    if (!item) return;
    if (Number(state.user.points || 0) < Number(item.cost || 0)) { toast('可用积分不足'); return; }
    state.user.points = Number(state.user.points || 0) - Number(item.cost || 0);
    state.user.rewardRedemptions = state.user.rewardRedemptions || [];
    state.user.rewardRedemptions.push({ id: uid(), rewardId: item.id, name: item.name, cost: Number(item.cost || 0), status: 'pending', createdAt: new Date().toISOString() });
    state.user.log = state.user.log || [];
    state.user.log.push({ date: today(), type: 'reward_redeem', detail: `兑换奖励：${item.name}（-${item.cost} 积分）`, xp: 0 });
    sync().then(() => { renderAll(); toast('兑换成功，等待发放'); });
  } else if (a === 'reward-fulfill') {
    if (!canOverrideHomework()) { toast('仅空间创建者可确认发放'); return; }
    const r = (state.user.rewardRedemptions || []).find(x => x.id === id);
    if (!r || r.status !== 'pending') return;
    r.status = 'fulfilled';
    r.handledAt = new Date().toISOString();
    state.user.log = state.user.log || [];
    state.user.log.push({ date: today(), type: 'reward_fulfill', detail: `已发放兑换奖励：${r.name}`, xp: 0 });
    sync().then(() => { renderAll(); toast('已标记发放'); });
  } else if (a === 'reward-cancel') {
    if (!canOverrideHomework()) { toast('仅空间创建者可取消兑换'); return; }
    const r = (state.user.rewardRedemptions || []).find(x => x.id === id);
    if (!r || r.status !== 'pending') return;
    r.status = 'canceled';
    r.handledAt = new Date().toISOString();
    state.user.points = Number(state.user.points || 0) + Number(r.cost || 0);
    state.user.log = state.user.log || [];
    state.user.log.push({ date: today(), type: 'reward_cancel', detail: `取消兑换并返还：${r.name}（+${r.cost} 积分）`, xp: 0 });
    sync().then(() => { renderAll(); toast('已取消并返还积分'); });
  } else if (a === 'reward-item-del') {
    if (!canOverrideHomework()) { toast('仅空间创建者可管理奖励'); return; }
    state.user.rewardItems = normalizeRewardItems(state.user.rewardItems);
    const item = state.user.rewardItems.find(x => x.id === id);
    if (!item) return;
    item.active = false;
    state.user.log = state.user.log || [];
    state.user.log.push({ date: today(), type: 'reward_item_del', detail: `下架奖励：${item.name}`, xp: 0 });
    sync().then(() => { renderAll(); toast('奖励已下架'); });
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
  } catch (err) { $('#au-err').textContent = friendlyError(err); }
});

// 启动：恢复 Supabase 浏览器会话
setAuthMode('login');
ensureHomeworkDefaults();
loadCurrentUser().then(user => {
  if (!user) return;
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  renderAll();
  startRefresh();
}).catch(err => {
  $('#au-err').textContent = friendlyError(err);
});
