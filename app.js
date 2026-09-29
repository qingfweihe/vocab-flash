/* 闪过背单词 — 单机 PWA 逻辑
 * 数据: data/words.json  (units[].words[])
 * 进度: localStorage 'sgwd_progress_v1'
 */
'use strict';

/* ================= 状态 ================= */
const LS_KEY = 'sgwd_progress_v1';
const DEFAULT_STATE = {
  learned: {},   // unitId(str) -> {wordKey: true} 已标记掌握
  wrong: {},     // unitId(str) -> {wordKey: true} 错词
  favorites: {}, // unitId(str) -> {wordKey: true} 收藏（以后再复习）
  stats: { tested: 0, correct: 0 },
  settings: { rate: 0.9, fontSize: 17, sakura: true, theme: 'auto' },
  scrolls: {},   // unitId(str) -> 学习页滚动位置
  lastUnit: null,
  reminder: { id: '', enabled: false, time: '20:00', smart: true },  // 推送提醒
  todo: [],      // 待办清单 [{id,text,type:'once'|'daily'|'weekly',date?,time,wd?,done?,todayDone?,createdAt}]
  reading: { done: {}, vocab: {} },  // 阅读随手练 done:{id:{pick,ok,ts}} vocab:{word:{cn,ts}}
  listen: { done: {}, vocab: {} },   // 听力精听 done:{taskId:{answered,correct,ts}} vocab:{word:{cn,ts}}
  favStars: {},  // 收藏星级 unitId -> {wordKey: {v:0..3, ts}}（星越多越熟练）
  sync: { code: '', partner: '', on: false, lastSync: 0, tomb: {}, ntfyTopic: '', pushplusToken: '' },  // 云同步（tomb=删除墓碑 key→±ts）
};

let DATA = { meta: {}, units: [] };
let META = null;          // 轻量索引（单元名+词数），首屏秒开用
let DATA_PROMISE = null;  // 全量词库加载 Promise（后台并行）
let state = loadState();

/** 阅读状态规整（深防御：绝不与 DEFAULT_STATE 共享内层对象，否则重置后残留记录） */
function normalizeReading(r) {
  r = r || {};
  return {
    done: (r.done && typeof r.done === 'object' && !Array.isArray(r.done)) ? r.done : {},
    vocab: (r.vocab && typeof r.vocab === 'object' && !Array.isArray(r.vocab)) ? r.vocab : {},
  };
}

/** 听力状态规整（同上；done 键为段 id，如 legacy-22-06-1-a1） */
function normalizeListen(l) {
  l = l || {};
  return {
    done: (l.done && typeof l.done === 'object' && !Array.isArray(l.done)) ? l.done : {},
    vocab: (l.vocab && typeof l.vocab === 'object' && !Array.isArray(l.vocab)) ? l.vocab : {},
  };
}

/** 打卡：阅读与听力共用一套（今天练过任意一项即算打卡） */
function bjDateOf(ts) { return new Date((ts || Date.now()) + 8 * 3600e3).toISOString().slice(0, 10); }
function practiceDays() {
  const days = new Set();
  const r = (state && state.reading) || {};
  Object.keys(r.done || {}).forEach((k) => days.add(bjDateOf(r.done[k] && r.done[k].ts)));
  const l = (state && state.listen) || {};
  Object.keys(l.done || {}).forEach((k) => days.add(bjDateOf(l.done[k] && l.done[k].ts)));
  return days;
}
function streakFrom(days) {
  let streak = 0;
  const d = new Date();
  if (!days.has(bjDateOf())) d.setDate(d.getDate() - 1); // 今天还没练，从昨天算
  for (;;) {
    if (days.has(bjDateOf(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const s = JSON.parse(raw);
    return {
      learned: s.learned || {},
      wrong: s.wrong || {},
      favorites: s.favorites || {},
      stats: s.stats || { tested: 0, correct: 0 },
      settings: Object.assign({}, DEFAULT_STATE.settings, s.settings || {}),
      scrolls: s.scrolls || {},
      lastUnit: s.lastUnit || null,
      reminder: Object.assign({}, DEFAULT_STATE.reminder, s.reminder || {}),
      todo: Array.isArray(s.todo) ? s.todo : [],
      reading: normalizeReading(s.reading),
      listen: normalizeListen(s.listen),
      favStars: (s.favStars && typeof s.favStars === 'object' && !Array.isArray(s.favStars)) ? s.favStars : {},
      sync: Object.assign({ code: '', partner: '', on: false, lastSync: 0, tomb: {} }, s.sync || {}),
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  if (typeof Reminder !== 'undefined') Reminder.ping(); // 学习动作后上报（自带节流）
  if (typeof Sync !== 'undefined') Sync.markDirty();    // 改动后节流上传云端
}

/* ================= 工具 ================= */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), ms);
}

function unitById(id) { return DATA.units.find((u) => u.id === Number(id)); }

/** HTML 转义：用户输入渲染进 innerHTML 前必过 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---- 进度存储：以词头（小写）为键，词库重排不会错位 ---- */
function wordKey(w) { return String(w).toLowerCase(); }
function learnedMap(id) { return state.learned[String(id)] || (state.learned[String(id)] = {}); }
function wrongMap(id) { return state.wrong[String(id)] || (state.wrong[String(id)] = {}); }
function isLearned(id, w) { return !!learnedMap(id)[wordKey(w)]; }
function isWrong(id, w) { return !!wrongMap(id)[wordKey(w)]; }
function setLearned(id, w, v) { const m = learnedMap(id); if (v) m[wordKey(w)] = true; else delete m[wordKey(w)]; }
function setWrong(id, w, v) {
  const m = wrongMap(id), k = wordKey(w);
  if (v) { m[k] = true; if (typeof Sync !== 'undefined') Sync.untomb('w:' + id + ':' + k); }
  else if (m[k]) { delete m[k]; if (typeof Sync !== 'undefined') Sync.tomb('w:' + id + ':' + k); }
}
/* 收藏 */
function favMap(id) { return state.favorites[String(id)] || (state.favorites[String(id)] = {}); }
function isFav(id, w) { return !!favMap(id)[wordKey(w)]; }
function setFav(id, w, v) {
  const m = favMap(id), k = wordKey(w);
  if (v) { m[k] = true; if (typeof Sync !== 'undefined') Sync.untomb('f:' + id + ':' + k); }
  else {
    delete m[k];
    if (state.favStars && state.favStars[String(id)]) delete state.favStars[String(id)][k]; // 取消收藏同时清掉星级
    if (typeof Sync !== 'undefined') Sync.tomb('f:' + id + ':' + k);
  }
}
/* 收藏星级：0~3，星越多越熟练；取消收藏时一并清除 */
function favStarMap(id) { return state.favStars[String(id)] || (state.favStars[String(id)] = {}); }
function getFavStar(id, w) { const e = favStarMap(id)[wordKey(w)]; return (e && e.v) || 0; }
function setFavStar(id, w, v) { favStarMap(id)[wordKey(w)] = { v: v | 0, ts: Date.now() }; }
function countKeys(store, id) {
  const v = store[String(id)];
  if (!v) return 0;
  return Array.isArray(v) ? v.length : Object.keys(v).length;  // 兼容旧数组格式
}

/* ================= 云同步（多设备共用进度 · 双人互戳） =================
 * 后端：CloudBase 云函数 /api（动作分发）。设计要点：
 * - 推送节流 30s，各域内容哈希不变则跳过；拉取在打开应用/切前台时触发
 * - 合并规则：进度/错词/收藏=并集，阅读/听力记录=按条目 ts 新者胜，待办=按 id + 完成态优先
 * - 删除用墓碑（state.sync.tomb，key→±ts）：删除记正、重添记负；服务端合并时统一过滤 */
const Sync = (() => {
  const API_DEFAULT = 'https://qinfweihe1-d5gxpjjli9f8f238b.service.tcloudbase.com/api';
  const PUSH_DELAY = 30000;
  const DOMAINS = ['progress', 'vocab', 'reading', 'listening', 'todo', 'meta', 'srs'];
  let API = localStorage.getItem('sgwd_api') || API_DEFAULT;
  if (!API || /deno\.(dev|net)/.test(API)) API = API_DEFAULT; // Deno 后端已停用
  let applyingRemote = false;
  let pushTimer = null;
  let inFlight = false;

  function cfg() {
    if (!state.sync) state.sync = { code: '', partner: '', on: false, lastSync: 0, tomb: {} };
    if (!state.sync.tomb) state.sync.tomb = {};
    return state.sync;
  }
  function hashes() { try { return JSON.parse(localStorage.getItem('sgwd_sync_hashes') || '{}'); } catch (e) { return {}; } }
  function setHash(d, h) { const m = hashes(); m[d] = h; try { localStorage.setItem('sgwd_sync_hashes', JSON.stringify(m)); } catch (e) {} }
  function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); }
  function status(msg, cls) { const el = $('#sync-status'); if (el) { el.textContent = msg; el.className = 'set-note' + (cls ? ' ' + cls : ''); } }

  async function request(action, payload) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000); // 弱网下 15 秒必给反馈，不挂起按钮
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action, code: cfg().code || undefined }, payload || {})),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(tid);
      if (e.name === 'AbortError') { const err = new Error('网络超时（15 秒无响应）'); err.code = 'TIMEOUT'; throw err; }
      throw e;
    }
    clearTimeout(tid);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) { const e = new Error((j && j.message) || ('HTTP ' + res.status)); e.code = j && j.error; throw e; }
    return j;
  }

  function tomb(key) { cfg().tomb[key] = Date.now(); }
  function untomb(key) { const t = cfg().tomb; if (t[key] !== undefined) t[key] = -Date.now(); }

  function domainPayload(d) {
    if (d === 'progress') return { learned: state.learned };
    if (d === 'vocab') return { wrong: state.wrong, favorites: state.favorites, favStars: state.favStars || {} };
    if (d === 'reading') return { reading: { done: state.reading.done, vocab: state.reading.vocab } };
    if (d === 'listening') return { listen: { done: state.listen.done, vocab: state.listen.vocab } };
    if (d === 'todo') return { todo: state.todo, dailyCfg: state.dailyCfg || {}, dailyTasks: state.dailyTasks || [] };
    if (d === 'srs') return { srs: state.srs || {}, dayLog: state.dayLog || {} };
    let learnedTotal = 0;
    for (const k in state.learned) learnedTotal += countKeys(state.learned, k);
    const tc = todayCount();
    return {
      tomb: cfg().tomb, lastActive: Date.now(), learnedTotal,
      streak: streakFrom(practiceDays()),          // 结对排行：连续打卡
      todayCount: (tc.n || 0) + (tc.r || 0),        // 结对排行：今日学习量
    };
  }
  function domainHash(d) {
    const p = domainPayload(d);
    if (d === 'meta') {
      // 只按「墓碑 + 活跃度小时桶」算指纹：活跃度最多每小时推一次，保证智能提醒判据新鲜
      return djb2(JSON.stringify({ t: p.tomb || {}, la: Math.floor((p.lastActive || 0) / 3600000) }));
    }
    return djb2(JSON.stringify(p));
  }

  function markDirty() {
    if (applyingRemote || !cfg().on || !cfg().code) return;
    clearTimeout(pushTimer);
    // 先拉取合并、再上传：服务端是纯存储（读-改-写会踩 CDN 回源延迟丢数据）
    pushTimer = setTimeout(() => { pullMerge().then(() => pushAll(false)).catch(() => {}); }, PUSH_DELAY);
  }

  async function pushAll(force) {
    if (!cfg().on || !cfg().code || inFlight) return;
    inFlight = true;
    try {
      const hs = hashes();
      for (const d of DOMAINS) {
        const h = domainHash(d);
        if (!force && hs[d] === h) continue;
        await request('state.put', { domain: d, data: domainPayload(d) });
        setHash(d, h);
      }
      cfg().lastSync = Date.now();
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
      status('已同步 ✓ ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'ok');
    } catch (e) {
      status('同步失败：' + String(e.message || e).slice(0, 70), 'err');
      throw e;
    } finally { inFlight = false; }
  }

  async function pullMerge() {
    if (!cfg().on || !cfg().code || inFlight) return;
    inFlight = true;
    try {
      const r = await request('state.get', { domain: 'ALL' });
      const dom = (r && r.domains) || {};
      // 对方在自己手机上完成结对后，这一侧自动认到伙伴码（免手动重填）
      let adoptedPartner = '';
      if (r && r.partner && !cfg().partner) {
        cfg().partner = r.partner;
        adoptedPartner = r.partner;
      }
      const meta = (dom.meta && dom.meta.data) || {};
      const tombs = meta.tomb || {};
      let changed = false;
      applyingRemote = true;
      try {
        const pl = (dom.progress && dom.progress.data && dom.progress.data.learned) || {};
        for (const u in pl) {
          const lm = learnedMap(u);
          for (const w in (pl[u] || {})) if (!lm[w]) { lm[w] = true; changed = true; }
        }
        const vv = (dom.vocab && dom.vocab.data) || {};
        for (const bagName of ['wrong', 'favorites']) {
          const src = vv[bagName] || {}, dst = state[bagName];
          for (const u in src) {
            if (!dst[u]) { dst[u] = {}; changed = true; }
            for (const w in (src[u] || {})) if (!dst[u][w]) { dst[u][w] = true; changed = true; }
          }
        }
        // 星级：按条目 ts 新者胜
        if (vv.favStars) {
          const dstS = state.favStars || (state.favStars = {});
          for (const u in vv.favStars) {
            const src = vv.favStars[u] || {};
            if (!dstS[u]) { dstS[u] = {}; changed = true; }
            for (const w in src) {
              const inc = src[w] || {}, cur = dstS[u][w];
              if (!cur || (inc.ts || 0) > (cur.ts || 0)) { dstS[u][w] = inc; changed = true; }
            }
          }
        }
        for (const [dn, key] of [['reading', 'reading'], ['listening', 'listen']]) {
          const wrap = ((dom[dn] || {}).data || {})[key];
          if (!wrap) continue;
          for (const id in (wrap.done || {})) {
            const inc = wrap.done[id], cur = state[key].done[id];
            if (!cur || (inc.ts || 0) > (cur.ts || 0)) { state[key].done[id] = inc; changed = true; }
          }
          for (const w in (wrap.vocab || {})) {
            const inc = wrap.vocab[w], cur = state[key].vocab[w];
            if (!cur || (inc.ts || 0) > (cur.ts || 0)) { state[key].vocab[w] = inc; changed = true; }
          }
        }
        // SRS：按条目 last 新者胜；dayLog 按天取各字段 max（合并双设备不会丢计数）
        const srsInc = ((dom.srs || {}).data || {});
        if (srsInc.srs) {
          const m = srsMap();
          for (const k in srsInc.srs) {
            const inc = srsInc.srs[k], cur = m[k];
            if (!cur || (inc.last || 0) > (cur.last || 0)) { m[k] = inc; changed = true; }
          }
        }
        if (srsInc.dayLog) {
          const g = todayLog();
          for (const d2 in srsInc.dayLog) {
            const inc = srsInc.dayLog[d2] || {}, cur = g[d2];
            if (!cur) { g[d2] = inc; changed = true; }
            else {
              const n = Math.max(cur.n || 0, inc.n || 0), r = Math.max(cur.r || 0, inc.r || 0);
              if (n !== (cur.n || 0) || r !== (cur.r || 0)) { g[d2] = { n, r }; changed = true; }
            }
          }
        }
        const incTodo = ((dom.todo || {}).data || {}).todo;
        if (Array.isArray(incTodo)) {
          const map = {};
          (state.todo || []).forEach(x => { map[x.id] = x; });
          incTodo.forEach(x => {
            const cur = map[x.id];
            if (!cur) { map[x.id] = x; changed = true; }
            else if ((x.done === true && cur.done !== true) || (x.createdAt || 0) > (cur.createdAt || 0)) { map[x.id] = x; changed = true; }
          });
          state.todo = Object.keys(map).map(k => map[k]).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }
        // 每日任务：cfg 按 _ts 新者胜（整体 LWW）；tasks 按 id 合并、done/doneTs 取 doneTs 大者
        const dTodo = ((dom.todo || {}).data || {});
        if (dTodo.dailyCfg && typeof dTodo.dailyCfg === 'object') {
          const myTs = dailyCfg()._ts || 0;
          if ((dTodo.dailyCfg._ts || 0) > myTs) { state.dailyCfg = dTodo.dailyCfg; changed = true; }
        }
        if (Array.isArray(dTodo.dailyTasks)) {
          const dtMap = {};
          dailyTasks().forEach((x) => { dtMap[x.id] = x; });
          dTodo.dailyTasks.forEach((x) => {
            if (!x || !x.id) return;
            const cur = dtMap[x.id];
            if (!cur) { dtMap[x.id] = x; changed = true; }
            else if ((x.doneTs || 0) > (cur.doneTs || 0)) { cur.done = x.done || ''; cur.doneTs = x.doneTs || 0; changed = true; }
          });
          state.dailyTasks = Object.keys(dtMap).map((k) => dtMap[k]).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }
        // 墓碑合并：云端 tomb 并入本地（同 key 取 |ts| 更大者），再统一过滤删除项
        const localT = cfg().tomb;
        for (const k in tombs) {
          const a = localT[k], b2 = tombs[k];
          if (a === undefined) { localT[k] = b2; changed = true; }
          else if (Math.abs(b2) > Math.abs(a)) { localT[k] = b2; changed = true; }
        }
        for (const k in localT) {
          if (!(localT[k] > 0)) continue;
          if (k.startsWith('w:') || k.startsWith('f:')) {
            const p = k.split(':');
            const bag = p[0] === 'w' ? state.wrong : state.favorites;
            if (bag[p[1]] && bag[p[1]][p[2]]) { delete bag[p[1]][p[2]]; changed = true; }
            if (p[0] === 'f' && state.favStars && state.favStars[p[1]] && state.favStars[p[1]][p[2]]) {
              delete state.favStars[p[1]][p[2]]; changed = true; // 取消收藏同时清星级
            }
          } else if (k.startsWith('rv:')) {
            const w = k.slice(3);
            if (state.reading.vocab[w]) { delete state.reading.vocab[w]; changed = true; }
          } else if (k.startsWith('lv:')) {
            const w = k.slice(3);
            if (state.listen.vocab[w]) { delete state.listen.vocab[w]; changed = true; }
          } else if (k.startsWith('t:')) {
            const id = k.slice(2);
            if ((state.todo || []).some(x => x.id === id)) { state.todo = state.todo.filter(x => x.id !== id); changed = true; }
          }
        }
      } finally { applyingRemote = false; }
      if (changed) saveState();
      cfg().lastSync = Date.now();
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
      if (changed) renderAfterSync();
      if (adoptedPartner) { renderUI(); toast('已与 ' + adoptedPartner + ' 结对 ✓ 可以互戳了'); }
      status('已同步 ✓ ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'ok');
    } catch (e) {
      status('拉取失败：' + String(e.message || e).slice(0, 70), 'err');
    } finally { inFlight = false; }
  }

  function renderAfterSync() {
    try {
      renderUnits(); renderWrongList(); renderTodo();
      if (typeof renderFavorites === 'function') { renderFavorites(); restoreListPos('#fav-list', 'fav'); }
      Reading.renderWrongVocab(); Listening.renderWrongVocab();
    } catch (e) { /* 当前视图未挂载时忽略 */ }
  }

  async function ensureCode() {
    const c = cfg();
    if (c.code) {
      try { await request('init', {}); return c.code; }
      catch (e) { if (e.code !== 'NO_SUCH_CODE') throw e; }
    }
    const r = await request('init', {});
    c.code = r.code; c.on = true;
    saveState();
    return c.code;
  }
  async function ensureOn() {
    await ensureCode();
    if (!cfg().on) { cfg().on = true; saveState(); renderUI(); }
  }

  async function enable() {
    status('正在开启云同步…');
    try { await ensureCode(); } catch (e) { status('开启失败：' + String(e.message || e).slice(0, 70), 'err'); return false; }
    cfg().on = true;
    saveState(); renderUI();
    pullMerge().then(() => pushAll(true)).catch(() => {});
    return true;
  }
  function disable() { cfg().on = false; saveState(); renderUI(); status('云同步已暂停（云端数据保留，重新打开即恢复）', ''); }

  /** 清空进度后调用：清墓碑 + 全域整体覆盖上传（union 会复活旧数据，必须 replace） */
  async function afterReset() {
    cfg().tomb = {};
    for (const d of DOMAINS) {
      try {
        await request('state.put', { domain: d, data: domainPayload(d) });
        setHash(d, domainHash(d));
      } catch (e) { /* 单域失败忽略 */ }
    }
  }

  function isShell() {
    // 安卓 App 壳（WebView + 定时取件）会注入 window.vfShell
    try { return !!(window.vfShell && window.vfShell.setSyncCode); } catch (e) { return false; }
  }
  function tellShell() {
    try { if (isShell() && cfg().code) window.vfShell.setSyncCode(cfg().code); } catch (e) { /* 老壳无此方法 */ }
  }

  function renderUI() {
    const c = cfg();
    tellShell();
    const on = $('#sync-on'); if (on) on.checked = !!c.on;
    const code = $('#sync-code'); if (code) code.value = c.code || '';
    const p = $('#sync-partner'); if (p && document.activeElement !== p) p.value = c.partner || '';
    if (c.on && c.code) {
      status((c.partner ? '已开启 · 伙伴 ' + c.partner : '已开启') + (c.lastSync ? ' · 上次同步 ' + new Date(c.lastSync).toLocaleTimeString('zh-CN', { hour12: false }) : ''), 'ok');
    } else if (!c.on && c.code) {
      status('已暂停（云端数据保留）', '');
    }
  }

  function init() {
    const on = $('#sync-on');
    if (!on) return;
    on.checked = !!cfg().on;
    renderUI();
    on.addEventListener('change', async () => {
      if (on.checked) { const okRes = await enable(); on.checked = !!okRes; }
      else disable();
    });
    $('#sync-copy').addEventListener('click', async () => {
      const v = cfg().code || '';
      if (!v) { status('先开启云同步生成同步码', 'err'); return; }
      try { await navigator.clipboard.writeText(v); toast('同步码已复制'); }
      catch (e) { const el = $('#sync-code'); el.select(); try { document.execCommand('copy'); toast('同步码已复制'); } catch (e2) { toast('复制失败，请手动长按选择'); } }
    });
    $('#sync-pair').addEventListener('click', async () => {
      const p = $('#sync-partner').value.trim().toUpperCase();
      if (!cfg().code) { status('先开启云同步', 'err'); return; }
      if (!/^[A-Z2-7]{12}$/.test(p)) { status('伙伴码应为 12 位大写字母数字', 'err'); return; }
      if (p === cfg().code) { status('不能和自己结对', 'err'); return; }
      status('正在结对…');
      try {
        await request('pair', { partner: p });
        cfg().partner = p; saveState(); renderUI();
        status('已与 ' + p + ' 结对 ✓ 现在可以互戳了', 'ok');
        refreshPartnerStatus();
      } catch (e) { status('结对失败：' + String(e.message || e).slice(0, 60), 'err'); }
    });
    $('#sync-push').addEventListener('click', async () => {
      if (!cfg().on) { status('先开启云同步', 'err'); return; }
      status('正在同步…');
      try { await pullMerge(); await pushAll(true); } catch (e) { /* 状态已显示 */ }
    });
    $('#sync-poke').addEventListener('click', async () => {
      if (!cfg().partner) { status('先填写伙伴码并结对', 'err'); return; }
      try {
        const r = await request('poke', { to: cfg().partner, text: '该背单词啦！' });
        const d = (r && r.delivered) || {};
        const pushSent = (d.push && d.push.sent) || 0;
        const ntfyOk = !!(d.ntfy && d.ntfy.published);
        if (pushSent > 0 && ntfyOk) toast('已戳 TA ✓ 两条通道都发了');
        else if (pushSent > 0) toast('已戳 TA ✓ 网页推送已发出');
        else if (ntfyOk) toast('已戳 TA ✓ 已发到 TA 的 ntfy');
        else if (d.ntfy && d.ntfy.skipped === 'no-topic') toast('已放进消息盒：TA 还没生成 ntfy 主题');
        else toast('已放进 TA 的消息盒（TA 暂时收不到提醒）');
        refreshPartnerStatus();
      } catch (e) { toast(String(e.message || e).slice(0, 60)); }
    });

    // ---- 账号密码（同步码的友好登录入口） ----
    const acctGet = () => { try { return JSON.parse(localStorage.getItem('sgwd_account') || 'null'); } catch (e) { return null; } };
    const acctSet = (v) => { if (v) localStorage.setItem('sgwd_account', JSON.stringify(v)); else localStorage.removeItem('sgwd_account'); };
    function renderAcct() {
      const logged = $('#acct-logged'), form = $('#acct-form'), out = $('#acct-out-wrap');
      if (!logged || !form || !out) return;
      const a = acctGet();
      if (a && a.user) {
        logged.textContent = '已登录：' + a.user + ' ✓ 进度已绑定到账号（换设备登录即可取回）';
        logged.classList.remove('hidden');
        form.classList.add('hidden');
        out.classList.remove('hidden');
      } else {
        logged.classList.add('hidden');
        form.classList.remove('hidden');
        out.classList.add('hidden');
      }
    }
    async function accountTakeover(code) {
      // 登录后把账号绑定的码接过来：合并云端进度到本地，再整体上传
      await request('init', { code });
      cfg().code = code; cfg().on = true;
      saveState(); renderUI();
      await pullMerge(); await pushAll(true);
    }
    $('#acct-register').addEventListener('click', async () => {
      const user = ($('#acct-user').value || '').trim();
      const pass = ($('#acct-pass').value || '');
      if (!user || !pass) { status('填好用户名和密码再注册', 'err'); return; }
      status('正在注册…');
      try {
        if (!cfg().code) { await ensureCode(); } // 没开同步的先本地生成码，注册时一并绑定
        const r = await request('account.register', { user, pass, code: cfg().code });
        acctSet({ user: r.user, ts: Date.now() });
        cfg().code = r.code; cfg().on = true;
        saveState(); renderUI(); renderAcct();
        await pushAll(true);
        status('已登录：' + r.user + ' ✓ 进度已绑定账号', 'ok');
        toast('注册成功 ✓ 换设备登录即可取回进度', 3200);
      } catch (e) {
        const m2 = String(e.message || e).slice(0, 60);
        status('注册失败：' + m2, 'err');
        toast('注册失败：' + m2, 3000);
      }
    });
    $('#acct-login').addEventListener('click', async () => {
      const user = ($('#acct-user').value || '').trim();
      const pass = ($('#acct-pass').value || '');
      if (!user || !pass) { status('填好用户名和密码再登录', 'err'); return; }
      status('正在登录并取回进度…');
      try {
        const r = await request('account.login', { user, pass });
        await accountTakeover(r.code);
        acctSet({ user: r.user, ts: Date.now() });
        renderAcct();
        status('已登录：' + r.user + ' ✓ 进度已取回', 'ok');
        toast('登录成功 ✓ 进度已取回', 3000);
      } catch (e) {
        const msg = String(e.message || e);
        const friendly = msg.indexOf('不存在') >= 0 ? '账号不存在，先点「注册」' : msg.slice(0, 60);
        status('登录失败：' + friendly, 'err');
        toast('登录失败：' + friendly, 3200);
      }
    });
    $('#acct-logout').addEventListener('click', () => {
      acctSet(null);
      renderAcct();
      status('已退出账号（云同步与进度不受影响）', 'ok');
    });
    renderAcct();

    // ---- 对方状态检查（让"他到底连没连上"一眼可见） ----
    function agoText(ts) {
      if (!ts) return '未知';
      const m = Math.floor((Date.now() - ts) / 60000);
      if (m < 2) return '刚刚';
      if (m < 60) return m + ' 分钟前';
      const h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时前';
      return Math.floor(h / 24) + ' 天前';
    }
    async function refreshPartnerStatus() {
      const el = $('#partner-status');
      if (!el) return;
      if (!cfg().partner) { el.textContent = ''; return; }
      try {
        const r = await request('partner.status', { partner: cfg().partner });
        const s = (r && r.partner) || {};
        // 排行对比（我 vs 对方）：今日学习量 + 连续天数 + 总词量
        const myStreak = streakFrom(practiceDays());
        const mtc = todayCount();
        const myToday = (mtc.n || 0) + (mtc.r || 0);
        let myTotal = 0;
        for (const k in state.learned) myTotal += countKeys(state.learned, k);
        const win = (a, b) => a === b ? '' : (a > b ? ' 🏆' : '');
        const rank = `🔥 今日：我 ${myToday} 词${win(myToday, s.todayCount || 0)} ⇄ 他 ${s.todayCount || 0} 词${win(s.todayCount || 0, myToday)}`
          + ` · 连续：我 ${myStreak} 天${win(myStreak, s.streak || 0)} ⇄ 他 ${s.streak || 0} 天${win(s.streak || 0, myStreak)}`
          + ` · 累计：我 ${myTotal} ⇄ 他 ${s.learnedTotal || 0}`;
        const bits = [];
        bits.push(s.hasNtfy ? '已连 ntfy ✓' : '未设置 ntfy（通知收不到）');
        if (s.pushCount) bits.push('网页推送 ' + s.pushCount + ' 台设备');
        if (s.reminderEnabled) bits.push('已开每日提醒');
        bits.push('最后活跃 ' + agoText(s.lastActive || s.lastSeen));
        el.innerHTML = `对方状态：<br>${rank}<br>${bits.join(' · ')}`;
        el.className = 'set-note' + (s.hasNtfy ? ' ' : ' err');
      } catch (e) {
        el.textContent = '对方状态：读取失败（' + String(e.message || e).slice(0, 40) + '）';
      }
    }
    const refreshBtn = $('#partner-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshPartnerStatus);
    // ---- 已有同步码接管（第二台设备） ----
    const toBtn = $('#sync-takeover-btn');
    if (toBtn) toBtn.addEventListener('click', async () => {
      const c = ($('#sync-takeover').value || '').trim().toUpperCase();
      if (!/^[A-Z2-7]{12}$/.test(c)) { status('同步码应为 12 位大写字母数字', 'err'); return; }
      if (c === cfg().code) { status('这就是本机的同步码', 'err'); return; }
      if (!confirm('接管会把云端那份进度的与本机现有进度合并（取并集），继续？')) return;
      status('正在接管…');
      try {
        await request('init', { code: c }); // 校验云端存在
        cfg().code = c; cfg().on = true;
        saveState(); renderUI();
        await pullMerge(); await pushAll(true);
        status('已接管 ' + c + ' ✓ 进度已合并', 'ok');
      } catch (e) { status('接管失败：' + String(e.message || e).slice(0, 70), 'err'); }
    });

    // ---- 安卓通知（ntfy） ----
    const nStatus = (msg, cls) => { const el = $('#ntfy-status'); if (el) { el.textContent = msg; el.className = 'set-note' + (cls ? ' ' + cls : ''); } };
    const nTopicEl = $('#ntfy-topic');
    function renderNtfy() { if (nTopicEl) nTopicEl.value = (cfg().ntfyTopic) || ''; }
    renderNtfy();
    async function saveTopic(t) {
      const r = await request('ntfy.set', { topic: t });
      cfg().ntfyTopic = r.ntfyTopic || '';
      saveState();
      renderNtfy();
    }
    const genBtn = $('#ntfy-gen');
    if (genBtn) genBtn.addEventListener('click', async () => {
      try { await ensureOn(); } catch (e) { nStatus('需要先开通云同步（自动开通失败：' + String(e.message || e).slice(0, 50) + '）', 'err'); return; }
      const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let t = 'vf-';
      for (let i = 0; i < 14; i++) t += alpha[Math.floor(Math.random() * alpha.length)];
      nStatus('正在保存主题…');
      try { await saveTopic(t); nStatus('已生成 ✓ 点「复制主题」，到 ntfy App 里订阅它', 'ok'); }
      catch (e) { nStatus('生成失败：' + String(e.message || e).slice(0, 60), 'err'); }
    });
    const copyBtn = $('#ntfy-copy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const t = cfg().ntfyTopic || '';
      if (!t) { nStatus('先点「生成」得到主题', 'err'); return; }
      try { await navigator.clipboard.writeText(t); toast('主题已复制，去 ntfy App 里订阅'); }
      catch (e) { const el = $('#ntfy-topic'); el.select(); try { document.execCommand('copy'); toast('主题已复制'); } catch (e2) { toast('复制失败，请长按输入框选择'); } }
    });
    const tBtn = $('#ntfy-test');
    if (tBtn) tBtn.addEventListener('click', async () => {
      if (!(cfg().ntfyTopic)) { nStatus('先生成主题，并在 ntfy App 里订阅', 'err'); return; }
      nStatus('正在发送测试通知…');
      try {
        const r = await request('ntfy.test', {});
        const okPub = r.result && r.result.published;
        nStatus(okPub ? '测试已发出：几秒内手机应弹通知（没收到检查 ntfy 的省电/自启动设置）' : '发送失败：' + JSON.stringify(r.result || {}).slice(0, 80), okPub ? 'ok' : 'err');
      } catch (e) { nStatus('测试失败：' + String(e.message || e).slice(0, 70), 'err'); }
    });

    const helpBtn = $('#ntfy-copyhelp');
    if (helpBtn) helpBtn.addEventListener('click', async () => {
      const topic = cfg().ntfyTopic || '';
      const A = 'https://gh-proxy.com/https://github.com/binwiederhier/ntfy-android/releases/download/v1.25.2/ntfy-1.25.2-fdroid-release.apk';
      const B = 'https://ghproxy.net/https://github.com/binwiederhier/ntfy-android/releases/download/v1.25.2/ntfy-1.25.2-fdroid-release.apk';
      const C = 'https://ghfast.top/https://github.com/binwiederhier/ntfy-android/releases/download/v1.25.2/ntfy-1.25.2-fdroid-release.apk';
      const txt = [
        '【闪过背单词 · 手机设置】',
        '',
        '1) 用手机浏览器打开（在微信里打开的话，点右上角「…」→ 在浏览器打开）：',
        'https://qingfweihe.github.io/vocab-flash/',
        '',
        '2) 进「设置 → 云同步」→ 开启 → 把你的同步码发回给我（我这边结对后就能互相戳）。',
        '',
        '3) 进「设置 → 微信通知」：',
        '   手机浏览器打开 https://www.pushplus.plus/ → 微信扫码登录 → 完成一次实名 → 复制 token',
        '   → 回到应用粘贴 token → 点保存 → 点发送测试，微信里马上会收到一条「服务通知」。',
        '',
        '4) 回到「设置 → 提醒」把每日提醒开关打开（提醒会走微信通道）。',
        '',
        '5) （可选）装成 App 的样子：Chrome/Edge 菜单 →「安装应用」；国产自带浏览器找「添加到桌面」。',
        '',
        '备用通道 ntfy（微信搞不定时再用）：应用商店搜 ntfy，搜不到就下载：',
        A,
        '装好后在应用「备用通道」里生成主题并订阅。',
      ].join('\n');
      nStatus('正在复制说明…');
      try {
        await navigator.clipboard.writeText(txt);
        nStatus('已复制 ✓ 去微信粘贴给朋友即可', 'ok');
      } catch (e) {
        try {
          const ta = document.createElement('textarea');
          ta.value = txt;
          ta.style.cssText = 'position:fixed;left:-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          nStatus('已复制 ✓ 去微信粘贴给朋友即可', 'ok');
        } catch (e2) { nStatus('复制失败：请手动长按上方说明复制', 'err'); }
      }
    });

    // ---- 微信通知（PushPlus，安卓首选通道） ----
    const wxStatus = (msg, cls) => { const el = $('#wx-status'); if (el) { el.textContent = msg; el.className = 'set-note' + (cls ? ' ' + cls : ''); } };
    const wxTokenEl = $('#wx-token');
    function renderWx() { if (wxTokenEl) wxTokenEl.value = cfg().pushplusToken || ''; }
    renderWx();
    const wxSave = $('#wx-save');
    if (wxSave) wxSave.addEventListener('click', async () => {
      try { await ensureOn(); } catch (e) { wxStatus('需要先开通云同步（自动开通失败，请到上面「云同步」手动开启）', 'err'); return; }
      const t = (wxTokenEl.value || '').trim();
      if (t && !/^[A-Za-z0-9_-]{16,64}$/.test(t)) { wxStatus('口令看起来不对：应是 20~40 位的字母数字（从 PushPlus 复制）', 'err'); return; }
      wxStatus('正在保存…');
      try {
        const r = await request('wechat.set', { token: t });
        cfg().pushplusToken = r.pushplusToken || '';
        saveState(); renderWx();
        wxStatus(t ? '已保存 ✓ 点「发送测试」验证' : '已清除', 'ok');
      } catch (e) { wxStatus('保存失败：' + String(e.message || e).slice(0, 60), 'err'); }
    });
    const wxTest = $('#wx-test');
    if (wxTest) wxTest.addEventListener('click', async () => {
      if (!cfg().pushplusToken) { wxStatus('先把口令粘贴到上面并点「保存」', 'err'); return; }
      wxStatus('正在发送测试…');
      try {
        const r = await request('wechat.test', {});
        const res = (r && r.result) || {};
        if (res.published) wxStatus('已发出：去微信看看「服务通知」', 'ok');
        else if (String(res.resp || '').indexOf('905') >= 0) wxStatus('对方账号还没实名：去 pushplus.plus 完成实名后再试', 'err');
        else wxStatus('发送失败：' + String(res.resp || res.error || '').slice(0, 90), 'err');
      } catch (e) { wxStatus('测试失败：' + String(e.message || e).slice(0, 70), 'err'); }
    });

    const apiInput = $('#rem-api');
    if (apiInput && !apiInput.value) apiInput.value = API;
    apiInput.addEventListener('change', () => {
      API = apiInput.value.trim().replace(/\/+$/, '') || API_DEFAULT;
      localStorage.setItem('sgwd_api', API);
      status('后端地址已更新', 'ok');
    });
    document.addEventListener('visibilitychange', () => {
      if (!cfg().on || !cfg().code) return;
      if (document.visibilityState === 'visible') pullMerge().catch(() => {});
      else { clearTimeout(pushTimer); pullMerge().then(() => pushAll(false)).catch(() => {}); }
    });
    if (cfg().on && cfg().code) pullMerge().catch(() => {});
    if (cfg().partner) refreshPartnerStatus(); // 打开设置页即看对方连接状态
  }

  return { init, markDirty, tomb, untomb, request, ensureOn, ensureCode, enable, disable, pushAll, pullMerge, afterReset, isShell };
})();

/* 旧格式（数组下标）迁移为词头键；全量词库加载后调用一次 */
function migrateProgress() {
  let changed = false;
  for (const u of DATA.units) {
    const uid = String(u.id);
    for (const store of [state.learned, state.wrong, state.favorites]) {
      const v = store[uid];
      if (Array.isArray(v)) {
        const m = {};
        v.forEach((i) => { if (u.words[i]) m[wordKey(u.words[i].w)] = true; });
        store[uid] = m;
        changed = true;
      }
    }
  }
  if (changed) saveState();
}

/* 旧"自定义事项"（reminder.custom）迁移为待办清单；不依赖词库，启动即可跑 */
function migrateTodo() {
  const old = state.reminder && state.reminder.custom;
  if (!Array.isArray(old) || !old.length) return;
  state.todo = state.todo || [];
  old.forEach((x, i) => {
    if (!x || !x.when) return;
    const [d, t] = String(x.when).split('T');
    const exists = state.todo.some((it) => it.type === 'once' && it.date === d && (it.time || '') === (t || '') && it.text === x.text);
    if (!exists) {
      state.todo.push({ id: String(x.id || 't' + Date.now() + i), text: String(x.text || ''), type: 'once', date: d, time: t || '09:00', done: false, createdAt: Date.now() });
    }
  });
  delete state.reminder.custom;
  saveState();
}

/* ================= 待办清单 ================= */
const TODO_LIMIT = 50;
const bjToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京时间今天

function todoLabel(it) {
  const wd = '日一二三四五六';
  if (it.type === 'daily') return `每天 ${it.time}`;
  if (it.type === 'weekly') return `每周${wd[Number(it.wd) || 0]} ${it.time}`;
  return `${String(it.date || '').replace(/-/g, '/').slice(5)} ${it.time}`;
}
function todoExpired(it) {
  if (it.type !== 'once' || it.done) return false;
  const plan = new Date(`${it.date}T${it.time}:00`).getTime();
  return Date.now() - plan > 12 * 3600e3;
}

/** 待办页顶部的推送提醒状态条 */
function renderTodoRemBar() {
  const sw = $('#todo-rem-switch');
  if (!sw) return;
  const r = state.reminder || {};
  const on = !!r.enabled;
  sw.checked = on;
  const st = $('#todo-rem-state');
  const sub = $('#todo-rem-sub');
  if (!Reminder.pushSupported()) {
    st.textContent = '不支持'; st.className = 'trb-off';
    sub.textContent = '当前浏览器不支持通知（需 iOS 16.4+）';
  } else if (!Reminder.isStandalone()) {
    st.textContent = '待主屏'; st.className = 'trb-off';
    sub.textContent = '先把应用「添加到主屏幕」再开启';
  } else if (on) {
    st.textContent = '已开启 ✓'; st.className = 'trb-on';
    sub.textContent = `每日背单词 ${r.time || '20:00'} + 待办到点推送`;
  } else {
    st.textContent = '未开启'; st.className = 'trb-off';
    sub.textContent = '开启后待办到点会推送通知';
  }
}

function renderTodo() {
  const box = $('#todo-list');
  if (!box) return;
  const items = (state.todo || []).slice().sort((a, b) => {
    const ka = a.type === 'once' ? `0${a.date}T${a.time}` : `1${a.time}`;
    const kb = b.type === 'once' ? `0${b.date}T${b.time}` : `1${b.time}`;
    return ka.localeCompare(kb);
  });
  if (!items.length) {
    box.innerHTML = '<div class="todo-empty">还没有待办。点右上角「＋ 新建」添加一条，到点会推送通知提醒你。</div>';
    return;
  }
  const today = bjToday();
  box.innerHTML = items.map((it) => {
    const exp = todoExpired(it);
    const cls = (it.type === 'once' && it.done ? 'done' : '') + (exp ? ' expired' : '');
    const checked = (it.type === 'once' && it.done) || (it.todayDone === today);
    const lbl = esc(todoLabel(it));
    const whenHtml = exp ? `<span class="t-expired">已过期</span> · ${lbl}` : lbl;
    return `
      <div class="todo-item ${cls}" data-id="${esc(it.id)}">
        <button class="tk ${checked ? 'on' : ''}" data-tk="${esc(it.id)}">${checked ? '✓' : ''}</button>
        <div class="t-main">
          <div class="t-text">${esc(it.text)}</div>
          <div class="t-when">${whenHtml}${it.type === 'daily' || it.type === 'weekly' ? ` · 勾选=今天不再提醒` : ''}</div>
        </div>
        <button class="t-del" data-del="${esc(it.id)}">删除</button>
      </div>`;
  }).join('');
}

let todoFormType = 'once';
function showTodoForm(show) {
  const f = $('#todo-form');
  if (!f) return;
  f.classList.toggle('hidden', !show);
  if (show) {
    // 预填一次性时间：当前 +1 小时（datetime-local 按设备本地时区，iPhone 通常就是北京时间）
    const local = new Date(Date.now() + 3600e3);
    const pad = (n) => String(n).padStart(2, '0');
    $('#todo-when-once').value = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
    $('#todo-text').focus();
  }
}
function setTodoType(t) {
  todoFormType = t;
  $$('#todo-type-row .todo-type').forEach((b) => b.classList.toggle('active', b.dataset.type === t));
  $('#todo-when-once').classList.toggle('hidden', t !== 'once');
  $('#todo-when-daily').classList.toggle('hidden', t !== 'daily');
  $('#todo-when-weekly').classList.toggle('hidden', t !== 'weekly');
}

function bindTodo() {
  // 推送提醒状态条：开关 + 测试通知（与设置页的开关控制同一状态）
  const remSw = $('#todo-rem-switch');
  if (remSw) {
    remSw.addEventListener('change', async () => {
      if (remSw.checked) {
        const ok = await Reminder.enable();
        if (!ok) remSw.checked = !!state.reminder.enabled;
      } else {
        await Reminder.disable();
      }
      renderTodoRemBar();
    });
  }
  const remTest = $('#todo-rem-test');
  if (remTest) remTest.addEventListener('click', async () => {
    if (!state.reminder.enabled || !state.reminder.id) { toast('先开启推送提醒'); return; }
    toast('正在发送测试通知…');
    try {
      await Reminder.sendTest();
    } catch (e) { /* Reminder 内部已提示 */ }
    renderTodoRemBar();
  });

  $('#btn-todo-new').addEventListener('click', () => showTodoForm($('#todo-form').classList.contains('hidden')));
  $('#todo-type-row').addEventListener('click', (e) => {
    const b = e.target.closest('.todo-type');
    if (b) setTodoType(b.dataset.type);
  });
  $('#todo-save').addEventListener('click', () => {
    const text = $('#todo-text').value.trim();
    if (!text) { toast('先写一下要提醒的事'); return; }
    if ((state.todo || []).length >= TODO_LIMIT) { toast(`最多 ${TODO_LIMIT} 条，先删几条吧`); return; }
    let item = null;
    if (todoFormType === 'once') {
      const when = $('#todo-when-once').value;
      if (!when) { toast('请选择日期时间'); return; }
      const [d, t] = when.split('T');
      item = { id: 't' + Date.now(), text, type: 'once', date: d, time: t, done: false, createdAt: Date.now() };
    } else if (todoFormType === 'daily') {
      item = { id: 't' + Date.now(), text, type: 'daily', time: $('#todo-when-daily').value || '20:00', createdAt: Date.now() };
    } else {
      item = { id: 't' + Date.now(), text, type: 'weekly', wd: Number($('#todo-wd').value), time: $('#todo-when-weekly-time').value || '20:00', createdAt: Date.now() };
    }
    state.todo.push(item);
    $('#todo-text').value = '';
    saveState(); renderTodo(); Reminder.sync(true);
    showTodoForm(false);
    toast('已添加，到点会推送通知 ✓');
  });
  $('#todo-list').addEventListener('click', (e) => {
    const tk = e.target.closest('[data-tk]');
    const del = e.target.closest('[data-del]');
    if (tk) {
      const it = state.todo.find((x) => x.id === tk.dataset.tk);
      if (!it) return;
      if (it.type === 'once') {
        it.done = !it.done;
      } else {
        it.todayDone = it.todayDone === bjToday() ? '' : bjToday();
      }
      saveState(); renderTodo(); Reminder.sync(true);
    } else if (del) {
      if (typeof Sync !== 'undefined') Sync.tomb('t:' + del.dataset.del);
      state.todo = state.todo.filter((x) => x.id !== del.dataset.del);
      saveState(); renderTodo(); Reminder.sync(true);
    }
  });
}

/* ================= 发音 ================= */
let enVoice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  enVoice = vs.find((v) => v.lang === 'en-US' && /Samantha|Google|Zira|Aria/i.test(v.name))
    || vs.find((v) => v.lang === 'en-US')
    || vs.find((v) => /^en/i.test(v.lang)) || null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(word) {
  // 安卓壳（WebView 无 speechSynthesis）：发音走壳内系统 TTS
  try {
    if (window.vfShell && typeof window.vfShell.speak === 'function') {
      window.vfShell.speak(String(word));
      return;
    }
  } catch (e) { /* 退化到网页 TTS */ }
  if (!window.speechSynthesis) { toast('当前浏览器不支持语音'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = Number(state.settings.rate) || 0.9;
  if (enVoice) u.voice = enVoice;
  speechSynthesis.speak(u);
}

/* ================= 视图路由 ================= */
let currentView = 'units';
let inStudy = false; // 是否处于"学习态"：底部「单词」tab 会据此回到学习页而非列表
const TAB_VIEWS = ['units', 'favorites', 'todo', 'wrong', 'settings'];

function nav(view) {
  if (window.speechSynthesis) speechSynthesis.cancel(); // 切页即停朗读
  if (currentView === 'study' && view !== 'study') {
    saveStudyPos();                    // 离开学习页前保存精确位置（词级）
    if (view === 'units') inStudy = false; // 只有主动回列表才算退出学习态
  }
  if (currentView === 'favorites' && view !== 'favorites') saveListPos('#fav-list', 'fav');
  if (currentView === 'wrong' && view !== 'wrong') saveListPos('#wrong-list', 'wrong');
  currentView = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (el) el.classList.remove('hidden');
  $$('#tabbar .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === view || (view === 'study' && b.dataset.nav === 'units'));
  });
  if (TAB_VIEWS.includes(view)) window.scrollTo({ top: 0 });
  if (view === 'units' && typeof renderContinue === 'function') renderContinue();
  if (view === 'units' && typeof renderToday === 'function') { renderToday(); renderHeat(); }
  if (view === 'units') { Reading.renderHome(); Listening.renderHome(); }
  if (view === 'wrong') { renderWrongList(); restoreListPos('#wrong-list', 'wrong'); }
  if (view === 'favorites' && typeof renderFavorites === 'function') { renderFavorites(); Reading.renderWrongVocab(); Listening.renderWrongVocab(); restoreListPos('#fav-list', 'fav'); }
  if (view === 'todo') { renderTodo(); renderTodoRemBar(); }
  if (view === 'reading') Reading.renderPage();
  if (view === 'listening') Listening.renderPage();
}

document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('[data-nav]');
  if (!navBtn) return;
  let v = navBtn.dataset.nav;
  // 底部「单词」tab：若正在学习中，切回学习页（保持原地）；页内「‹ 返回」则真回列表
  if (v === 'units' && inStudy && studyUnitId != null && navBtn.closest('#tabbar')) {
    nav('study');
    const u = unitById(studyUnitId);
    if (u) setTimeout(() => restorePos(u), 60);
    return;
  }
  nav(v);
});

/* ================= 渲染：单元列表 & 总进度 ================= */
function renderUnits() {
  const box = $('#unit-list');
  box.innerHTML = '';
  let totalWords = 0, totalLearned = 0, totalWrong = 0;

  // 有全量用全量；否则用轻量索引先渲染（首屏秒开）
  const info = DATA.units.length
    ? DATA.units.map((u) => ({ id: u.id, name: u.name, count: u.words.length }))
    : (META ? META.units : []);

  info.forEach((u) => {
    const n = u.count;
    const l = countKeys(state.learned, u.id);
    const w = countKeys(state.wrong, u.id);
    totalWords += n; totalLearned += l; totalWrong += w;
    const pct = n ? Math.round((l / n) * 100) : 0;

    const card = document.createElement('div');
    card.className = 'unit-card';
    card.innerHTML = `
      <div>
        <div class="unit-name">${u.name}</div>
        <div class="unit-meta">${n} 词 · 已学 ${l} · 错词 ${w}</div>
      </div>
      <div class="unit-right">
        <div class="unit-pct">${pct}%</div>
        <div class="unit-bar"><i style="width:${pct}%"></i></div>
      </div>`;
    card.addEventListener('click', () => openStudy(u.id));
    box.appendChild(card);
  });

  $('#stat-learned').textContent = totalLearned;
  $('#stat-total').textContent = totalWords;
  $('#stat-wrong').textContent = totalWrong;
  $('#stat-tested').textContent = state.stats.tested;

  const pct = totalWords ? totalLearned / totalWords : 0;
  const C = 2 * Math.PI * 42; // r=42
  $('#ring-fg').style.strokeDasharray = C;
  $('#ring-fg').style.strokeDashoffset = C * (1 - pct);
  $('#ring-text').textContent = Math.round(pct * 100) + '%';
  if (typeof renderContinue === 'function') renderContinue();
}

/* ================= 学习页 ================= */
let studyUnitId = null;

function ensureData() {
  if (DATA.units.length) return Promise.resolve(true);
  if (!DATA_PROMISE) {
    DATA_PROMISE = fetch('data/words.json', { cache: 'no-cache' })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.units && j.units.length) {
          DATA = j;
          migrateProgress(); // 旧下标键 -> 词头键（一次性）
          $('#topbar-sub').textContent = DATA.meta.subtitle || '';
          renderUnits();
          renderWrongList();
          return true;
        }
        DATA_PROMISE = null; // 数据异常：允许下次重试
        return false;
      })
      .catch(() => { DATA_PROMISE = null; return false; }); // 失败清空缓存，网络恢复后可重试
  }
  return DATA_PROMISE;
}

function openStudy(id, then, skipRestore) {
  const u = unitById(id);
  if (!u) {
    toast('词库加载中，请稍候…');
    ensureData().then((ok) => { if (ok) openStudy(id, then, skipRestore); else toast('词库加载失败，请联网后重试'); });
    return;
  }
  studyUnitId = id;
  state.lastUnit = id;
  inStudy = true;
  saveState();
  $('#study-title').textContent = `${u.name} · ${u.words.length} 词`;
  renderWordList();
  nav('study');
  if (!skipRestore) {
    setTimeout(() => restorePos(u), 60);
  }
  if (then) setTimeout(then, 80);
}

function gotoWord(unitId, idx) {
  openStudy(unitId, () => {
    const card = document.querySelector(`#word-list .word-card[data-idx="${idx}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    const d = card.querySelector('.wc-detail');
    if (d) d.classList.remove('collapsed');
    card.classList.add('locate');
    setTimeout(() => card.classList.remove('locate'), 2300);
  }, true);
}

/* ---------- 精确书签：记住"停在哪一个词" ---------- */
/** 当前视口内第一个可见词卡（顶部留 80px 给吸顶栏）所对应的词键 */
function currentTopWordKey() {
  const u = unitById(studyUnitId);
  if (!u) return '';
  const cards = document.querySelectorAll('#word-list .word-card');
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (r.bottom > 80) {
      const idx = Number(c.dataset.idx);
      if (u.words[idx]) return wordKey(u.words[idx].w);
      break;
    }
  }
  return '';
}

function saveStudyPos() {
  if (studyUnitId == null) return;
  const u = unitById(studyUnitId);
  if (!u) return;
  state.scrolls = state.scrolls || {};
  state.scrolls[String(studyUnitId)] = { w: currentTopWordKey(), y: window.scrollY };
  saveState();
}

/** 恢复：优先按词精确滚动并高亮提示；兼容旧的纯像素记录 */
function restorePos(u) {
  const rec = state.scrolls && state.scrolls[String(u.id)];
  if (rec && typeof rec === 'object' && rec.w) {
    const idx = u.words.findIndex((x) => wordKey(x.w) === rec.w);
    if (idx >= 0) {
      const card = document.querySelector(`#word-list .word-card[data-idx="${idx}"]`);
      if (card) {
        card.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -72); // 让出吸顶头部空间
        card.classList.add('locate');
        setTimeout(() => card.classList.remove('locate'), 2300);
        return;
      }
    }
  }
  const y = (rec && typeof rec === 'object' ? rec.y : rec) || 0; // 兼容旧数字格式
  window.scrollTo({ top: y });
}

/* 学习页滚动位置记忆（节流保存，词级） */
let scrollTimer = null;

/** 列表页（收藏/错词本）位置记忆：容器 + 存储键，卡片需带 data-key（uid:wordKey） */
function saveListPos(containerSel, storageKey) {
  const cards = document.querySelectorAll(containerSel + ' .word-card');
  let key = '';
  for (const c of cards) {
    if (c.getBoundingClientRect().bottom > 80) { key = c.dataset.key || ''; break; }
  }
  state.scrolls = state.scrolls || {};
  state.scrolls[storageKey] = { w: key, y: window.scrollY };
  saveState();
}
function restoreListPos(containerSel, storageKey) {
  const el = document.querySelector(containerSel);
  if (!el || el.offsetParent === null) return; // 视图不可见时不动作（防止误滚当前页）
  const rec = state.scrolls && state.scrolls[storageKey];
  if (!rec) return;
  if (typeof rec === 'object' && rec.w) {
    const cards = document.querySelectorAll(containerSel + ' .word-card');
    for (const c of cards) {
      if (c.dataset.key === rec.w) {
        c.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -72);
        c.classList.add('locate');
        setTimeout(() => c.classList.remove('locate'), 2300);
        return;
      }
    }
  }
  const y = (typeof rec === 'object' ? rec.y : rec) || 0;
  window.scrollTo({ top: y });
}

window.addEventListener('scroll', () => {
  if (currentView === 'study' && studyUnitId != null) {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveStudyPos, 250);
  } else if (currentView === 'favorites') {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => saveListPos('#fav-list', 'fav'), 250);
  } else if (currentView === 'wrong') {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => saveListPos('#wrong-list', 'wrong'), 250);
  }
}, { passive: true });

/** 单词详情行（背单词页与收藏页共用）：词根/例句/族/近/反/注 */
function wordDetailRows(w) {
  const rows = [];
  if (w.root) rows.push(`<div class="row"><span class="lab ji">记</span>${w.root}</div>`);
  if (w.exs && w.exs.length) {
    rows.push(`<div class="row"><span class="lab">例</span></div>` + w.exs.map((x) => `<div class="wc-ex">${x}</div>`).join(''));
  }
  if (w.fam) rows.push(`<div class="row"><span class="lab zu">族</span>${w.fam}</div>`);
  if (w.syn) rows.push(`<div class="row"><span class="lab li">近</span>${w.syn}</div>`);
  if (w.ant) rows.push(`<div class="row"><span class="lab fan">反</span>${w.ant}</div>`);
  if (w.note) rows.push(`<div class="row"><span class="lab">注</span>${w.note}</div>`);
  return rows.join('') || '<div class="row" style="color:#9a9aab">（无更多信息）</div>';
}

function renderWordList() {
  const u = unitById(studyUnitId);
  const box = $('#word-list');
  const hideCn = $('#chk-hide-cn').checked;
  box.innerHTML = '';

  u.words.forEach((w, idx) => {
    const card = document.createElement('div');
    card.className = 'word-card';
    card.dataset.idx = idx;

    const defsHtml = w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>');
    const rowsHtml = wordDetailRows(w);

    card.innerHTML = `
      <div class="wc-head">
        <div class="wc-main">
          <div class="wc-word-row">
            <span class="wc-word">${w.w}${isWrong(studyUnitId, w.w) ? ' <span style="color:#d84c4c;font-size:.7em">错词</span>' : ''}</span>
            ${w.freq ? `<span class="wc-freq">${w.freq}</span>` : ''}
            <button class="fav-btn${isFav(studyUnitId, w.w) ? ' on' : ''}" data-fav="${idx}" aria-label="收藏">${isFav(studyUnitId, w.w) ? '★' : '☆'}</button>
          </div>
          ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
          <div class="wc-cn${hideCn ? ' hide-cn' : ''}">${defsHtml}</div>
        </div>
        <div class="wc-actions">
          <button class="speak-btn" data-speak="${idx}">🔊</button>
          <label class="wc-learn" title="标记已学"><input type="checkbox" data-learn="${idx}" ${isLearned(studyUnitId, w.w) ? 'checked' : ''}></label>
        </div>
      </div>
      <div class="wc-detail collapsed" data-detail="${idx}">${rowsHtml}</div>`;

    // 点击卡片主体：展开详情 / 恢复模糊的中文
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('.speak-btn') || ev.target.closest('input')) return;
      const cn = card.querySelector('.wc-cn');
      if (cn.classList.contains('hide-cn')) { cn.classList.remove('hide-cn'); return; }
      const d = card.querySelector('.wc-detail');
      d.classList.toggle('collapsed');
    });

    card.querySelector('[data-speak]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      speak(w.w);
    });
    card.querySelector('[data-learn]').addEventListener('change', (ev) => {
      ev.stopPropagation();
      const on = ev.target.checked;
      setLearned(studyUnitId, w.w, on);
      if (on) {
        setWrong(studyUnitId, w.w, false); // 学会后从错词本移除
        srsInit(studyUnitId, w.w);         // 进 SRS 复习排期（明天首轮）
        logLearn('n');
      } else {
        srsRemove(studyUnitId, w.w);
      }
      saveState();
      renderUnits();
      if (typeof renderToday === 'function') renderToday();
    });
    card.querySelector('[data-fav]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = !isFav(studyUnitId, w.w);
      setFav(studyUnitId, w.w, on);
      saveState();
      ev.target.classList.toggle('on', on);
      ev.target.textContent = on ? '★' : '☆';
      toast(on ? '已收藏 ⭐ 之后可在「收藏」里复习' : '已取消收藏');
    });

    box.appendChild(card);
  });

  if (!u.words.length) box.innerHTML = '<div class="empty-tip">本单元暂无词条数据</div>';
}

$('#chk-hide-cn').addEventListener('change', () => renderWordList());

$('#btn-mark-all').addEventListener('click', () => {
  const u = unitById(studyUnitId);
  const cur = countKeys(state.learned, studyUnitId);
  if (cur === u.words.length) {
    state.learned[String(studyUnitId)] = {};
    toast('已取消全部标记');
  } else {
    const m = {};
    u.words.forEach((w) => { m[wordKey(w.w)] = true; });
    state.learned[String(studyUnitId)] = m;
    toast('已全部标记为已学');
  }
  saveState(); renderWordList(); renderUnits();
});

/* ================= SRS 间隔复习（简化 SM-2） =================
   数据 state.srs = { "unitId:wordKey": { n: 连对次数, due: 到期ts(北京日0点), last: 上次ts } }
   间隔（天）按连对次数取：[1,2,4,7,15,30,60,120]；模糊降一级且明天再来；忘了归零明天重来 */
const SRS_DAYS = [1, 2, 4, 7, 15, 30, 60, 120];

function srsMap() { if (!state.srs || typeof state.srs !== 'object') state.srs = {}; return state.srs; }
function srsKeyOf(unitId, w) { return unitId + ':' + wordKey(w); }
function bjDayStr(ts) { return new Date(((ts || Date.now()) + 8 * 3600e3)).toISOString().slice(0, 10); }
function dayStartTs(offsetDays) { // 北京日 0 点的 ts（offset=0 今天，1 明天…）
  const t = Date.now() + 8 * 3600e3 + (offsetDays || 0) * 86400e3;
  return Math.floor(t / 86400e3) * 86400e3 - 8 * 3600e3;
}
function srsInit(unitId, w) { // 新学会的词入库：明天首轮复习
  if (unitId == null || !w) return;
  const m = srsMap();
  const k = srsKeyOf(unitId, w);
  if (!m[k]) m[k] = { n: 0, due: dayStartTs(1), last: 0 };
}
function srsRemove(unitId, w) {
  const m = srsMap();
  delete m[srsKeyOf(unitId, w)];
}
function srsGrade(unitId, w, mode) { // mode: got 认得 / fuzzy 模糊 / nope 忘了
  if (unitId == null || !w) return;
  const m = srsMap();
  const k = srsKeyOf(unitId, w);
  const cur = m[k] || { n: 0, due: 0, last: 0 };
  if (mode === 'got') cur.n = Math.min(SRS_DAYS.length - 1, (cur.n || 0) + 1);
  else if (mode === 'fuzzy') cur.n = Math.max(0, (cur.n || 0) - 1);
  else cur.n = 0;
  cur.due = dayStartTs(mode === 'got' ? SRS_DAYS[cur.n] : 1);
  cur.last = Date.now();
  m[k] = cur;
}
function srsDueList() { // 今日到期（含逾期）
  const m = srsMap();
  const today = dayStartTs(0);
  const out = [];
  for (const k in m) {
    const e = m[k];
    if (!e || !e.due || e.due > today) continue;
    const p = k.split(':');
    const u = unitById(Number(p[0]));
    if (!u) continue;
    const idx = u.words.findIndex((x) => wordKey(x.w) === p[1]);
    if (idx >= 0) out.push({ unitId: u.id, idx, word: u.words[idx] });
  }
  return out;
}
function srsMigrateLearned() { // 老数据兜底：已学过但没进 SRS 的词，一次性入库（明天开始复习，不爆发）
  if (state.srsInitAt) return;
  const m = srsMap();
  for (const u in state.learned) {
    const bag = state.learned[u] || {};
    for (const wk in bag) {
      const k = u + ':' + wk;
      if (!m[k]) m[k] = { n: 0, due: dayStartTs(1), last: 0 };
    }
  }
  state.srsInitAt = Date.now();
  saveState();
}

/* 每日学习量（热力图数据源）：state.dayLog = { "2026-09-29": { n: 新词数, r: 复习数 } } */
function todayLog() { if (!state.dayLog || typeof state.dayLog !== 'object') state.dayLog = {}; return state.dayLog; }
function logLearn(kind) { // kind: 'n' 新词 / 'r' 复习
  const g = todayLog();
  const d = bjDayStr();
  g[d] = g[d] || { n: 0, r: 0 };
  g[d][kind] = (g[d][kind] || 0) + 1;
}
function todayCount() { const g = todayLog()[bjDayStr()] || {}; return { n: g.n || 0, r: g.r || 0 }; }
function dayTotal(dateStr) {
  const g = todayLog()[dateStr] || {};
  return (g.n || 0) + (g.r || 0);
}
function dailyGoal() { return Number((state.settings && state.settings.dailyGoal) || 20); }

/* ---------- 每日任务配置（用户可配） ----------
   state.dailyCfg = { newWords:{on,goal}, review:{on,cap}, reading:{on,goal}, listening:{on,goal} }
   state.dailyTasks = [{ id, text, done:"日期"|"", createdAt }]  done 存"打勾当天"的北京日期 → 次日自动未勾 */
function dailyCfg() {
  if (!state.dailyCfg || typeof state.dailyCfg !== 'object') state.dailyCfg = {};
  const c = state.dailyCfg;
  if (!c.newWords) c.newWords = { on: true, goal: dailyGoal() }; // 老字段 dailyGoal 迁移
  if (!c.review) c.review = { on: true, cap: 50 };
  if (!c.reading) c.reading = { on: false, goal: 1 };
  if (!c.listening) c.listening = { on: false, goal: 1 };
  return c;
}
function dailyTasks() {
  if (!Array.isArray(state.dailyTasks)) state.dailyTasks = [];
  return state.dailyTasks;
}
function dailyTaskDone(t) { return t.done === bjDayStr(); }
function dailyDoneCount() { return dailyTasks().filter(dailyTaskDone).length; }
function srsDueCapped() { // 复习队列按到期先后排序 + 每日上限截断（防停几天后积压压垮）
  const list = srsDueList().sort((a, b) => {
    const ea = srsMap()[srsKeyOf(a.unitId, a.word.w)] || {};
    const eb = srsMap()[srsKeyOf(b.unitId, b.word.w)] || {};
    return (ea.due || 0) - (eb.due || 0);
  });
  const cap = Number(dailyCfg().review.cap) || 0;
  return cap > 0 ? list.slice(0, cap) : list;
}
function readingDoneToday() { // 今天做过的阅读篇数
  const r = (state.reading && state.reading.done) || {};
  const d = bjDayStr();
  return Object.keys(r).filter((k) => r[k] && bjDayStr(r[k].ts) === d).length;
}
function listeningDoneToday() {
  const l = (state.listen && state.listen.done) || {};
  const d = bjDayStr();
  return Object.keys(l).filter((k) => l[k] && bjDayStr(l[k].ts) === d).length;
}

/* ================= 检验（闪卡） ================= */
let test = null; // {queue:[{unitId,idx,word}], pos, phase, origin, correct, wrongCount}

function buildQueueByUnit(id) {
  const u = unitById(id);
  const q = u.words.map((w, idx) => ({ unitId: id, idx, word: w }));
  shuffle(q);
  return q;
}

function buildQueueWrong() {
  const q = [];
  DATA.units.forEach((u) => {
    const m = state.wrong[String(u.id)] || {};
    const keys = Array.isArray(m) ? null : Object.keys(m);
    if (keys) {
      keys.forEach((k) => {
        const idx = u.words.findIndex((w) => wordKey(w.w) === k);
        if (idx >= 0) q.push({ unitId: u.id, idx, word: u.words[idx] });
      });
    } else {
      m.forEach((idx) => { if (u.words[idx]) q.push({ unitId: u.id, idx, word: u.words[idx] }); });
    }
  });
  shuffle(q);
  return q;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function buildQueueSrs() {
  const q = srsDueList();
  shuffle(q);
  return q;
}

/* ---------- 拼写模式（看中文+听音 → 拼英文） ---------- */
function showSpell(item) {
  const w = item.word;
  $('#flashcard').classList.add('hidden');
  $('#fc-judge').classList.add('hidden');
  $('#spell-stage').classList.remove('hidden');
  $('#test-mode').textContent = '咔 闪卡';
  $('#spell-cn').innerHTML = w.defs.map((d) => `<div><span class="pos">${d.pos || ''}</span>${d.cn || ''}</div>`).join('');
  const inp = $('#spell-input');
  inp.value = '';
  inp.disabled = false;
  $('#spell-submit').classList.remove('hidden');
  $('#spell-submit').disabled = false;
  $('#spell-result').classList.add('hidden');
  $('#spell-next').classList.add('hidden');
  window.scrollTo({ top: 0 });
  setTimeout(() => { try { inp.focus(); } catch (e) { } }, 80);
  speak(w.w); // 自动读一遍（听音拼写）
}

function spellDiff(you, right) {
  let html = '';
  for (let i = 0; i < right.length; i++) {
    const c = right[i];
    html += you[i] === c
      ? `<span class="ok">${c}</span>`
      : `<span class="no">${c}</span>`;
  }
  return html;
}

function spellSubmit() {
  if (!test || !test.queue[test.pos]) return;
  const item = test.queue[test.pos];
  const target = String(item.word.w).toLowerCase();
  const you = String($('#spell-input').value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!you) { toast('先拼一下再提交 🌸'); return; }
  const ok = you === target;

  state.stats.tested += 1;
  if (ok) state.stats.correct += 1;
  if (item.unitId != null && item.word) {
    srsGrade(item.unitId, item.word.w, ok ? 'got' : 'nope');
    logLearn('r');
  }
  if (ok) {
    setWrong(item.unitId, item.word.w, false);
    test.right += 1;
  } else {
    setWrong(item.unitId, item.word.w, true);
    test.miss.push(item);
  }
  saveState();
  if (typeof renderToday === 'function') renderToday();

  $('#spell-input').disabled = true;
  $('#spell-submit').classList.add('hidden');
  const res = $('#spell-result');
  res.classList.remove('hidden');
  if (ok) {
    res.className = 'spell-verdict ok';
    res.innerHTML = `✓ 拼对了：<b>${target}</b>`;
    setTimeout(() => { if (test && test.mode === 'spell') { test.pos += 1; showCard(); } }, 650);
    speak(item.word.w);
  } else {
    res.className = 'spell-verdict no';
    res.innerHTML = `✗ 拼错了<br>你的：<span class="spell-you">${you}</span><br>正确：<span class="spell-right">${spellDiff(you, target)}</span>`;
    $('#spell-next').classList.remove('hidden');
    speak(item.word.w);
  }
}

$('#spell-submit').addEventListener('click', spellSubmit);
$('#spell-next').addEventListener('click', () => { test.pos += 1; showCard(); });
$('#spell-speak').addEventListener('click', () => { if (test && test.queue[test.pos]) speak(test.queue[test.pos].word.w); });
$('#spell-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (!$('#spell-submit').classList.contains('hidden')) spellSubmit(); }
});
$('#test-mode').addEventListener('click', () => {
  if (!test) return;
  test.mode = test.mode === 'spell' ? 'flash' : 'spell';
  showCard();
});

function startTest(queue, title) {
  if (!queue.length) { toast('没有可检验的词'); return; }
  test = { queue, pos: 0, phase: 'read', origin: title, right: 0, miss: [], mode: (test && test.mode) || 'flash' };
  $('#test-title').textContent = title;
  nav('test');
  showCard();
}

function showCard() {
  const { queue, pos } = test;
  if (pos >= queue.length) { finishTest(); return; }
  const item = queue[pos];
  const w = item.word;

  $('#test-counter').textContent = `${pos + 1}/${queue.length}`;
  if (test.mode === 'spell') { showSpell(item); return; }
  $('#flashcard').classList.remove('hidden');
  $('#spell-stage').classList.add('hidden');
  $('#test-mode').textContent = 'Aa 拼写';
  $('#fc-word').textContent = w.w;
  $('#fc-phon').textContent = w.ph ? `[${w.ph}]` : '';
  $('#fc-defs').innerHTML = w.defs.map((d) => `<div><span class="pos">${d.pos || ''}</span>${d.cn || ''}</div>`).join('');
  $('#fc-root').textContent = w.root ? '记 ' + w.root : '';
  $('#fc-root').style.display = w.root ? '' : 'none';
  $('#fc-exs').innerHTML = (w.exs || []).map((x) => `<div>${x}</div>`).join('');
  $('#fc-exs').style.display = (w.exs && w.exs.length) ? '' : 'none';

  $('#fc-answer').classList.add('hidden');
  $('#fc-judge').classList.add('hidden');
  $('#btn-reveal').classList.remove('hidden');
  $('#test-stage').classList.remove('hidden');
  $('#test-done').classList.add('hidden');
  window.scrollTo({ top: 0 });
}

$('#btn-reveal').addEventListener('click', () => {
  $('#fc-answer').classList.remove('hidden');
  $('#btn-reveal').classList.add('hidden');
  $('#fc-judge').classList.remove('hidden');
  speak(test.queue[test.pos].word.w);
});

$('#fc-speak').addEventListener('click', () => speak(test.queue[test.pos].word.w));

$('#btn-got').addEventListener('click', () => judge('got'));
$('#btn-fuzzy').addEventListener('click', () => judge('fuzzy'));
$('#btn-nope').addEventListener('click', () => judge('nope'));

function judge(mode) { // got 认得 / fuzzy 模糊 / nope 忘了
  const item = test.queue[test.pos];
  const remembered = mode === 'got';
  state.stats.tested += 1;
  if (remembered) state.stats.correct += 1;

  // SRS 调度（词库外的自由词不进 SRS）
  if (item.unitId != null && item.word) {
    srsGrade(item.unitId, item.word.w, mode);
    logLearn('r');
  }
  if (remembered) {
    setWrong(item.unitId, item.word.w, false); // 从错词本移除
    test.right += 1;
  } else {
    if (mode === 'nope') setWrong(item.unitId, item.word.w, true); // 只有"忘了"进错词本
    test.miss.push(item);
  }
  saveState();

  test.pos += 1;
  showCard();
  if (typeof renderToday === 'function') renderToday();
  if (currentView === 'units') renderHeat();
}

function finishTest() {
  $('#test-stage').classList.add('hidden');
  $('#test-done').classList.remove('hidden');
  const n = test.queue.length;
  const r = test.right;
  $('#done-body').innerHTML = `本组共 ${n} 词<br>✅ 记住 ${r} · ❌ 没记住 ${n - r}<br>正确率 ${n ? Math.round((r / n) * 100) : 0}%`;
  renderUnits();
}

$('#btn-test-again').addEventListener('click', () => {
  if (!test || !test.miss.length) { toast('没有需要重测的词 🌸'); return; }
  startTest(test.miss.slice(), '重测没记住的');
});

$('#btn-test-unit').addEventListener('click', () => {
  const u = unitById(studyUnitId);
  startTest(buildQueueByUnit(studyUnitId), `检验 ${u.name}`);
});

$('#btn-test-wrong').addEventListener('click', () => {
  startTest(buildQueueWrong(), '检验错词本');
});

/* ================= 收藏夹 ================= */
/* 收藏筛选档位：全部 / 按星级一星一档（☆☆☆=未评，★★★=熟练）；检验收藏跟随当前档位 */
let favFilter = 'all';
const favOpen = new Set(); // 已展开详情的卡片 key（重渲染后保留展开状态）

function favCounts() {
  const c = { all: 0, s0: 0, s1: 0, s2: 0, s3: 0 };
  DATA.units.forEach((u) => {
    const m = state.favorites[String(u.id)] || {};
    if (Array.isArray(m)) return;
    Object.keys(m).forEach((k) => {
      c.all++;
      c['s' + getFavStar(u.id, k)]++;
    });
  });
  return c;
}
function favStarHtml(v) { return '★'.repeat(v) + '☆'.repeat(3 - v); }

function renderFavChips() {
  const chips = $('#fav-filters');
  if (!chips) return;
  const c = favCounts();
  chips.innerHTML = [
    ['all', '全部', c.all], ['s0', '☆☆☆', c.s0], ['s1', '★☆☆', c.s1], ['s2', '★★☆', c.s2], ['s3', '★★★', c.s3],
  ].map(([k, label, n]) => `<button class="fav-chip${favFilter === k ? ' on' : ''}" data-ff="${k}">${label} ${n}</button>`).join('');
  chips.querySelectorAll('[data-ff]').forEach((b) => b.addEventListener('click', () => {
    favFilter = b.dataset.ff;
    renderFavorites();
  }));
}

function renderFavorites() {
  const box = $('#fav-list');
  if (!box) return;
  box.innerHTML = '';
  renderFavChips();
  const items = [];
  DATA.units.forEach((u) => {
    const m = state.favorites[String(u.id)] || {};
    if (Array.isArray(m)) return;
    Object.keys(m).forEach((k) => {
      const w = u.words.find((x) => wordKey(x.w) === k);
      if (!w) return;
      items.push({ u, w, k, star: getFavStar(u.id, k) });
    });
  });
  const shown = items.filter((it) => favFilter === 'all' || it.star === Number(favFilter.slice(1)));
  if (!shown.length) {
    box.innerHTML = items.length
      ? '<div class="empty-tip">这一档是空的 👌<br>点上面的「全部」看看其它词</div>'
      : '<div class="empty-tip">收藏夹是空的 ⭐<br>学习时点单词旁的「☆」把不熟的词收进来，之后在这里集中复习</div>';
    return;
  }
  shown.forEach((it) => {
    const u = it.u, w = it.w, star = it.star;
    const key = u.id + ':' + it.k;
    const card = document.createElement('div');
    card.className = 'word-card';
    card.dataset.key = key;
    card.innerHTML = `
      <div class="wc-head">
        <div class="wc-main">
          <div class="wc-word-row">
            <span class="wc-word">${w.w}</span>
            <span class="mini-btn" style="border:none;background:#fff3d6;color:#b8860b">${u.name}</span>
            ${w.freq ? `<span class="wc-freq">${w.freq}</span>` : ''}
          </div>
          ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
          <div class="wc-cn">${w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>')}</div>
        </div>
        <div class="wc-actions">
          <button class="speak-btn">🔊</button>
          <button class="mini-btn" data-unfav>取消收藏</button>
        </div>
      </div>
      <button class="star-btn" data-star aria-label="熟练度"><span>熟练度</span> <b>${favStarHtml(star)}</b><span class="star-hint">点一下加一星</span></button>
      <div class="wc-detail${favOpen.has(key) ? '' : ' collapsed'}">${wordDetailRows(w)}</div>`;
    // 点卡片主体展开详情（避开按钮）；记住展开状态，重渲染后不折叠
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('.star-btn') || ev.target.closest('.speak-btn') || ev.target.closest('[data-unfav]')) return;
      const d = card.querySelector('.wc-detail');
      d.classList.toggle('collapsed');
      if (d.classList.contains('collapsed')) favOpen.delete(key); else favOpen.add(key);
    });
    card.querySelector('.speak-btn').addEventListener('click', (ev) => { ev.stopPropagation(); speak(w.w); });
    card.querySelector('[data-star]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const next = (getFavStar(u.id, w.w) + 1) % 4; // 0→1→2→3→0 循环
      setFavStar(u.id, w.w, next);
      saveState();
      const b = ev.currentTarget.querySelector('b');
      if (b) b.textContent = favStarHtml(next);
      renderFavChips(); // 数字实时更新，但不重建列表（避免滚动跳动）
      if (next === 3) toast('已标为熟练 ★★★');
      else if (next === 0) toast('已重置为 ☆☆☆');
    });
    card.querySelector('[data-unfav]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      favOpen.delete(key);
      setFav(u.id, w.w, false);
      saveState(); renderFavorites();
      toast('已取消收藏');
    });
    box.appendChild(card);
  });
}

function buildQueueFavorites() {
  const q = [];
  DATA.units.forEach((u) => {
    const m = state.favorites[String(u.id)] || {};
    const keys = Array.isArray(m) ? null : Object.keys(m);
    if (!keys) return;
    keys.forEach((k) => {
      const star = getFavStar(u.id, k);
      if (favFilter !== 'all' && star !== Number(favFilter.slice(1))) return; // 只考当前档位
      const idx = u.words.findIndex((w) => wordKey(w.w) === k);
      if (idx >= 0) q.push({ unitId: u.id, idx, word: u.words[idx] });
    });
  });
  shuffle(q);
  return q;
}

$('#btn-test-fav').addEventListener('click', () => {
  const q = buildQueueFavorites();
  if (!q.length) { toast(favFilter === 'all' ? '收藏夹是空的，先去学习中点 ☆ 收藏' : '这一档还没有词'); return; }
  const title = favFilter === 'all' ? '检验收藏' : '检验收藏 · ' + favStarHtml(Number(favFilter.slice(1)));
  startTest(q, title);
});

/* ================= 错词本 ================= */
function renderWrongList() {
  const box = $('#wrong-list');
  box.innerHTML = '';
  let count = 0;
  DATA.units.forEach((u) => {
    const m = state.wrong[String(u.id)] || {};
    const words = Array.isArray(m)
      ? m.map((idx) => u.words[idx]).filter(Boolean)
      : Object.keys(m).map((k) => u.words.find((x) => wordKey(x.w) === k)).filter(Boolean);
    if (!words.length) return;
    words.forEach((w) => {
      count++;
      const card = document.createElement('div');
      card.className = 'word-card';
      card.dataset.key = u.id + ':' + wordKey(w.w); // 位置记忆用
      card.innerHTML = `
        <div class="wc-head">
          <div class="wc-main">
            <div class="wc-word-row">
              <span class="wc-word">${w.w}</span>
              <span class="mini-btn tag-w" style="border:none;background:#fdeaea;color:#c66">${u.name}</span>
            </div>
            ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
            <div class="wc-cn">${w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>')}</div>
          </div>
          <div class="wc-actions">
            <button class="speak-btn">🔊</button>
            <button class="mini-btn" data-remove>掌握</button>
          </div>
        </div>`;
      card.querySelector('.speak-btn').addEventListener('click', (ev) => { ev.stopPropagation(); speak(w.w); });
      card.querySelector('[data-remove]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        setWrong(u.id, w.w, false);
        saveState(); renderWrongList(); renderUnits();
        toast('已移出错词本');
      });
      box.appendChild(card);
    });
  });
  if (!count) box.innerHTML = '<div class="empty-tip">错词本是空的 🌸<br>检验时「没记住」的词会出现在这里</div>';
}

/* ================= 设置 ================= */
function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty('--fs-base', s.fontSize + 'px');
  $('#set-rate').value = s.rate;
  $('#set-fontsize').value = s.fontSize;
  $('#set-sakura').checked = !!s.sakura;
  dailyCfg(); // 迁移默认值（老 dailyGoal → dailyCfg.newWords.goal）
  Sakura.setEnabled(!!s.sakura);
  applyTheme();
}

/** 夜间模式：auto 跟随系统 / light / dark；同步系统状态栏颜色 */
function applyTheme() {
  const t = (state.settings && state.settings.theme) || 'auto';
  const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = t === 'dark' || (t === 'auto' && sysDark);
  document.documentElement.classList.toggle('dark', dark);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = dark ? '#15161b' : '#ff6b9d';
  // 更新三档 chips 的选中态
  document.querySelectorAll('.theme-chip').forEach((b) => {
    b.classList.toggle('on', b.dataset.theme === t);
  });
}
// 系统深浅色变化时，跟随系统档实时切换
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => { if ((state.settings.theme || 'auto') === 'auto') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', onScheme);
  else if (mq.addListener) mq.addListener(onScheme);
}

document.querySelectorAll('.theme-chip').forEach((b) => {
  b.addEventListener('click', () => { state.settings.theme = b.dataset.theme; saveState(); applyTheme(); });
});
$('#set-rate').addEventListener('input', (e) => { state.settings.rate = Number(e.target.value); saveState(); });
$('#set-fontsize').addEventListener('input', (e) => {
  state.settings.fontSize = Number(e.target.value); saveState(); applySettings();
});
$('#set-sakura').addEventListener('change', (e) => {
  state.settings.sakura = e.target.checked; saveState(); Sakura.setEnabled(e.target.checked);
});

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = URL.createObjectURL(blob);
  a.download = `闪过背单词-进度备份-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('备份文件已生成');
});

$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const s = JSON.parse(r.result);
      state = {
        learned: s.learned || {}, wrong: s.wrong || {},
        favorites: s.favorites || {},
        stats: s.stats || { tested: 0, correct: 0 },
        settings: Object.assign({}, DEFAULT_STATE.settings, s.settings || {}),
        scrolls: s.scrolls || {},
        lastUnit: s.lastUnit || null,
        reminder: Object.assign({}, DEFAULT_STATE.reminder, s.reminder || {}),
        todo: Array.isArray(s.todo) ? s.todo : [],
        reading: normalizeReading(s.reading),
        listen: normalizeListen(s.listen),
        favStars: (s.favStars && typeof s.favStars === 'object' && !Array.isArray(s.favStars)) ? s.favStars : {},
        sync: Object.assign({ code: '', partner: '', on: false, lastSync: 0, tomb: {} }, s.sync || {}),
      };
      if (DATA.units.length) migrateProgress();
      saveState(); applySettings(); renderUnits(); renderWrongList();
      renderTodo(); Reading.renderHome(); Reading.renderWrongVocab();
      Listening.renderHome(); Listening.renderWrongVocab();
      Reminder.sync(true); renderTodoRemBar(); // 恢复的提醒设置/待办同步到服务端
      toast('进度已恢复');
    } catch (err) { toast('文件格式不对'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('确定清空全部学习进度？此操作不可恢复。')) return;
  await Reminder.disable(); // 先退订并同步服务端（enabled:false），防止清空后服务端继续推旧待办
  const keepSync = state.sync; // 同步码/结对关系保留，云端数据改为整体覆盖
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (keepSync) state.sync = keepSync;
  saveState(); applySettings(); renderUnits(); renderWrongList();
  renderTodo(); renderTodoRemBar();
  if (typeof Sync !== 'undefined' && state.sync.on && state.sync.code) Sync.afterReset().catch(() => {}); // 云端镜像清空
  toast('已清空');
});

/* ================= 樱花飘落 ================= */
const Sakura = (() => {
  const cv = $('#sakura');
  const ctx = cv.getContext('2d');
  let petals = [];
  let enabled = true;
  let W = 0, H = 0;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function make(n) {
    petals = [];
    const count = Math.min(26, Math.max(10, Math.round(W / 26)));
    for (let i = 0; i < count; i++) petals.push(newPetal(true));
  }
  function newPetal(init) {
    return {
      x: Math.random() * W,
      y: init ? Math.random() * H : -20,
      r: 5 + Math.random() * 6,
      vy: 0.35 + Math.random() * 0.65,
      sway: 0.6 + Math.random() * 1.2,
      phase: Math.random() * Math.PI * 2,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.02,
      a: 0.35 + Math.random() * 0.4,
      hue: 335 + Math.random() * 18,
    };
  }
  function petalPath(p) {
    // 五瓣樱花形（简化：5 个圆弧花瓣）
    const r = p.r;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const px = Math.cos(ang) * r * 0.85;
      const py = Math.sin(ang) * r * 0.85;
      ctx.moveTo(0, 0);
      ctx.arc(px * 0.5, py * 0.5, r * 0.55, 0, Math.PI * 2);
    }
  }
  let t = 0;
  function frame() {
    if (!enabled) { ctx.clearRect(0, 0, W, H); requestAnimationFrame(frame); return; }
    ctx.clearRect(0, 0, W, H);
    t += 0.016;
    for (const p of petals) {
      p.y += p.vy;
      p.x += Math.sin(t * p.sway + p.phase) * 0.5;
      p.rot += p.vr;
      if (p.y > H + 20 || p.x < -30 || p.x > W + 30) { Object.assign(p, newPetal(false)); }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = `hsla(${p.hue}, 85%, 82%, ${p.a})`;
      petalPath(p);
      ctx.fill();
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { resize(); make(); });
  resize();
  make();
  requestAnimationFrame(frame);

  return {
    setEnabled(v) { enabled = v; if (!v) ctx.clearRect(0, 0, W, H); },
  };
})();

/* ================= 阅读随手练 ================= */
const Reading = (() => {
  let ITEMS = null, PROMISE = null;
  let cur = null; // 当前正在做的题

  function ensure() {
    if (ITEMS) return Promise.resolve(true);
    if (!PROMISE) {
      PROMISE = fetch('data/readings.json', { cache: 'no-cache' })
        .then((r) => r.json())
        .then((j) => { if (j && j.items && j.items.length) { ITEMS = j.items; return true; } return false; })
        .catch(() => { PROMISE = null; return false; });
    }
    return PROMISE;
  }

  function rState() {
    if (!state.reading || typeof state.reading !== 'object') state.reading = { done: {}, vocab: {} };
    if (!state.reading.done) state.reading.done = {};
    if (!state.reading.vocab) state.reading.vocab = {};
    return state.reading;
  }

  function bjDate(ts) { return new Date((ts || Date.now()) + 8 * 3600e3).toISOString().slice(0, 10); }

  function stats() {
    const r = rState();
    const ids = Object.keys(r.done);
    const okN = ids.filter((k) => r.done[k].ok).length;
    // 连续刷题天数（北京时间）：与听力共用同一套打卡（见 practiceDays）
    const streak = streakFrom(practiceDays());
    return { done: ids.length, total: ITEMS ? ITEMS.length : 0, pct: ids.length ? Math.round(okN / ids.length * 100) : 0, streak };
  }

  function renderHome() {
    const sub = $('#reading-card-sub');
    const pct = $('#reading-card-pct');
    if (!sub) return;
    const s = stats();
    if (s.done) {
      sub.textContent = `已做 ${s.done} 篇 · 正确率 ${s.pct}%` + (s.streak > 1 ? ` · 连刷 ${s.streak} 天` : '');
      pct.textContent = s.pct + '%';
      pct.classList.remove('hidden');
    } else {
      sub.textContent = '六级真题 · 一篇一题 · 随手刷';
      pct.classList.add('hidden');
    }
  }

  function renderPage() {
    // 从别处切回阅读页时收起残留的做题界面——必须同步执行：
    // start() 会先走这里再同步渲染新题，若放到异步回调会把刚弹出的题面藏掉（"随机来一篇点不动"回归的根因）
    const q = $('#reading-quiz'), l = $('#reading-list');
    if (q) q.classList.add('hidden');
    if (l) l.classList.remove('hidden');
    // 先确保题库已加载：否则「做过的篇目」只能显示编号且点击无法定位文章（重做失灵的根因）
    ensure().then((ok) => { if (ok) renderPageInner(); });
  }

  function renderPageInner() {
    const box = $('#reading-stats');
    if (!box) return;
    const s = stats();
    box.innerHTML = `<div class="rs-item"><b>${s.done}</b><span>已做</span></div>
      <div class="rs-item"><b>${s.done ? s.pct + '%' : '—'}</b><span>正确率</span></div>
      <div class="rs-item"><b>${s.streak}</b><span>连刷天数</span></div>
      <div class="rs-item"><b>${s.total}</b><span>题库总量</span></div>`;
    // 做过列表（最近在前，可重做）
    const r = rState();
    const doneIds = Object.keys(r.done).sort((a, b) => r.done[b].ts - r.done[a].ts);
    const list = $('#reading-list');
    list.innerHTML = doneIds.length
      ? '<div class="set-note" style="margin:10px 2px 6px">做过的篇目（点击重做）</div>' + doneIds.map((id) => {
          const it = ITEMS && ITEMS.find((x) => x.id === id);
          const d = r.done[id];
          return `<div class="rd-item ${d.ok ? 'ok' : 'no'}" data-rd="${id}">
            <span class="rd-mark">${d.ok ? '✓' : '✗'}</span>
            <span class="rd-src">${it ? it.src : id}</span>
            <span class="rd-pick">选了 ${d.pick}</span>
          </div>`;
        }).join('')
      : '';
    list.querySelectorAll('[data-rd]').forEach((el) => el.addEventListener('click', () => {
      const it = ITEMS && ITEMS.find((x) => x.id === el.dataset.rd);
      if (it) { cur = it; renderQuiz(it, true); }
    }));
  }

  function start() {
    ensure().then((ok) => {
      if (!ok) { toast('题库加载失败，请联网重试'); return; }
      renderPage(); // 更新列表/统计
      const undone = ITEMS.filter((x) => !rState().done[x.id]);
      const pool = undone.length ? undone : ITEMS;
      cur = pool[Math.floor(Math.random() * pool.length)];
      renderQuiz(cur);
    });
  }

  function wrapWords(t) {
    return t.replace(/[A-Za-z][A-Za-z'’\-]*/g, (m) => `<span class="rd-w">${m}</span>`);
  }

  function renderQuiz(it, redo) {
    if (window.speechSynthesis) speechSynthesis.cancel(); // 换篇时停掉上一篇朗读
    $('#reading-list').classList.add('hidden');
    const box = $('#reading-quiz');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="rd-src-line">${it.src} · 约 ${it.words} 词
        <button class="rd-speak" id="rd-speak">🔊 朗读</button>
        <span class="rd-tts-ctrl hidden" id="rd-tts-ctrl">
          <button class="rd-speak" id="rd-pause">⏸ 暂停</button>
          <button class="rd-speak" id="rd-stop">⏹ 停止</button>
        </span>
      </div>
      <div class="rd-text">${wrapWords(it.text).replace(/\n/g, '</p><p class="rd-p">').replace(/^/, '<p class="rd-p">') + '</p>'}</div>
      <div class="rd-q">${it.q.stem}</div>
      <div class="rd-opts">${['A', 'B', 'C', 'D'].map((c, i) => `
        <button class="rd-opt" data-opt="${c}"><b>${c}</b> ${it.q.options[i]}</button>`).join('')}
      </div>
      <div id="rd-result" class="hidden"></div>
      <div class="rd-actions hidden" id="rd-actions">
        <button class="primary-btn" id="rd-next">再来一篇</button>
        <button class="ghost-btn" id="rd-back">返回阅读页</button>
      </div>`;
    box.querySelectorAll('.rd-opt').forEach((b) => b.addEventListener('click', () => pick(it, b.dataset.opt)));
    // 点词查释义（文章内任意单词）
    box.querySelector('.rd-text').addEventListener('click', (ev) => {
      const s = ev.target.closest('.rd-w');
      if (s) WordCard.show(s.textContent);
    });
    // 朗读：播放中可暂停/继续/停止
    const speakBtn = $('#rd-speak');
    const ttsCtrl = $('#rd-tts-ctrl');
    const pauseBtn = $('#rd-pause');
    const inShell = !!(window.vfShell && typeof window.vfShell.speak === 'function');
    let ttsPaused = false;
    const ttsReset = () => {
      ttsCtrl.classList.add('hidden');
      speakBtn.classList.remove('hidden');
      ttsPaused = false;
    };
    const stopAll = () => {
      try { if (inShell && window.vfShell.stopSpeak) window.vfShell.stopSpeak(); } catch (e) { }
      if (window.speechSynthesis) speechSynthesis.cancel();
    };
    speakBtn.addEventListener('click', () => {
      const text = it.text.replace(/\n/g, ' ');
      if (inShell) { // 壳内走系统 TTS（无暂停能力，只给停止）
        pauseBtn.classList.add('hidden');
        window.vfShell.speak(text);
        speakBtn.classList.add('hidden');
        ttsCtrl.classList.remove('hidden');
        return;
      }
      if (!window.speechSynthesis) { toast('当前浏览器不支持语音'); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = Number(state.settings.rate) || 0.9;
      if (enVoice) u.voice = enVoice;
      u.onend = ttsReset;
      u.onerror = ttsReset;
      speechSynthesis.speak(u);
      pauseBtn.classList.remove('hidden');
      speakBtn.classList.add('hidden');
      ttsCtrl.classList.remove('hidden');
      pauseBtn.textContent = '⏸ 暂停';
    });
    pauseBtn.addEventListener('click', () => {
      if (ttsPaused) { speechSynthesis.resume(); pauseBtn.textContent = '⏸ 暂停'; }
      else { speechSynthesis.pause(); pauseBtn.textContent = '▶ 继续'; }
      ttsPaused = !ttsPaused;
    });
    $('#rd-stop').addEventListener('click', () => { stopAll(); ttsReset(); });
    $('#rd-next').addEventListener('click', () => { start(); });
    $('#rd-back').addEventListener('click', () => { stopAll(); box.classList.add('hidden'); $('#reading-list').classList.remove('hidden'); renderPage(); });
    window.scrollTo({ top: 0 });
  }

  function pick(it, letter) {
    const r = rState();
    const ok = letter === it.q.answer;
    // 记录（重做覆盖）
    r.done[it.id] = { pick: letter, ok, ts: Date.now() };
    saveState();
    // 渲染结果
    document.querySelectorAll('#reading-quiz .rd-opt').forEach((b) => {
      b.disabled = true;
      if (b.dataset.opt === it.q.answer) b.classList.add('right');
      else if (b.dataset.opt === letter) b.classList.add('wrong');
    });
    const res = $('#rd-result');
    res.classList.remove('hidden');
    const vocabHtml = (it.vocab || []).length ? `
      <div class="rd-vocab-sec">
        <div class="rd-vhead"><b>本篇生词 · 点词翻面背诵</b><button class="rd-reveal" id="rd-vocab-reveal">全部显示</button></div>
        <div class="rd-vwords">${it.vocab.map((v) => {
          const faved = !!r.vocab[v.w];
          return `<div class="rd-vword" data-w="${v.w}">
            <button class="vw-main" data-w="${v.w}"><span class="vw-face">${v.w}</span><span class="vw-back hidden">${v.cn}</span></button>
            <button class="vw-fav ${faved ? 'on' : ''}" data-w="${v.w}" data-cn="${v.cn}" title="收藏到收藏夹">${faved ? '★' : '☆'}</button>
          </div>`;
        }).join('')}</div>
      </div>` : '';
    const cnHtml = it.cn ? `
      <button class="ghost-btn rd-cn-toggle" id="rd-cn-toggle">查看全文翻译</button>
      <div class="rd-cn hidden" id="rd-cn">${it.cn}</div>` : '';
    res.innerHTML = `
      <div class="rd-verdict ${ok ? 'ok' : 'no'}">${ok ? '✓ 答对了' : `✗ 答错了，正确答案 ${it.q.answer}`}</div>
      <div class="rd-explain">${it.q.explain}</div>
      ${vocabHtml}
      ${cnHtml}`;
    // 生词交互：翻面+发音；全部显示；收藏
    res.querySelectorAll('.vw-main').forEach((b) => b.addEventListener('click', () => {
      const back = b.querySelector('.vw-back');
      back.classList.toggle('hidden');
      if (!back.classList.contains('hidden')) speak(b.dataset.w);
    }));
    const reveal = $('#rd-vocab-reveal');
    if (reveal) reveal.addEventListener('click', () => {
      const backs = res.querySelectorAll('.vw-back');
      const show = res.querySelectorAll('.vw-back:not(.hidden)').length < backs.length; // 未全显示→全显示
      backs.forEach((s) => s.classList.toggle('hidden', !show));
      reveal.textContent = show ? '全部遮住' : '全部显示';
    });
    res.querySelectorAll('.vw-fav').forEach((b) => b.addEventListener('click', () => {
      const w = b.dataset.w;
      if (r.vocab[w]) { delete r.vocab[w]; if (typeof Sync !== 'undefined') Sync.tomb('rv:' + w); b.classList.remove('on'); b.textContent = '☆'; toast('已取消收藏'); }
      else { r.vocab[w] = { cn: b.dataset.cn, ts: Date.now() }; if (typeof Sync !== 'undefined') Sync.untomb('rv:' + w); b.classList.add('on'); b.textContent = '★'; toast('已收藏到收藏夹·阅读生词'); }
      saveState();
    }));
    const cnT = $('#rd-cn-toggle');
    if (cnT) cnT.addEventListener('click', () => {
      const box = $('#rd-cn');
      box.classList.toggle('hidden');
      cnT.textContent = box.classList.contains('hidden') ? '查看全文翻译' : '收起翻译';
    });
    $('#rd-actions').classList.remove('hidden');
    renderHome();
  }

  /** 收藏夹：阅读生词折叠分区 */
  function renderWrongVocab() {
    const box = $('#fav-read-list');
    if (!box) return;
    const wrap = $('#fav-read-box');
    const head = $('#fav-read-head');
    const r = rState();
    const words = Object.keys(r.vocab);
    if (wrap) wrap.classList.toggle('hidden', !words.length);
    if (head) head.textContent = `📖 阅读生词（${words.length}）`;
    if (!words.length) return;
    box.innerHTML = words.map((w) => `
      <div class="rem-item"><div><div>${w}</div><div class="rem-when">${r.vocab[w].cn}</div></div>
      <button class="rem-del" data-rvw="${w}">认识</button></div>`).join('');
    box.querySelectorAll('[data-rvw]').forEach((b) => b.addEventListener('click', () => {
      delete rState().vocab[b.dataset.rvw];
      if (typeof Sync !== 'undefined') Sync.tomb('rv:' + b.dataset.rvw);
      saveState(); renderWrongVocab();
    }));
  }

  function bind() {
    const card = $('#reading-card');
    if (card) card.addEventListener('click', () => nav('reading'));
    const btn = $('#btn-reading-start');
    if (btn) btn.addEventListener('click', start);
  }

  return { ensure, renderHome, renderPage, renderWrongVocab, bind, start, stats };
})();

/* ================= 六级听力精听 ================= */
/* 结构：卷列表 → 段列表（Sec A 第1组…）→ 精听页（播放器 / 题目 / 原文 / 中文）
   音频按需下载（SW 单独缓存，不预缓存），中文默认遮住，答完题或手动点开才显示。 */
const Listening = (() => {
  const LS_CACHE = 'sgwd-audio-v1';
  let IDX = null, PROMISE = null;       // 卷索引
  let paper = null, paperData = null;   // 当前卷
  let task = null;                      // 当前段
  let audio = null;                     // 复用的 <audio>
  let loopLine = -1;                    // 单句循环的行号（-1 = 关）
  let rate = 1;                         // 播放速度
  let showEn = false, showCn = false;   // 原文 / 中文 开关
  let unlocked = false;                 // 本段是否已解锁中文（答完题自动解锁）
  let wordMap = null;                   // 词库索引（小写 → 词条）
  let blobUrl = null, blobFor = null;   // 当前段音频的 Blob URL

  /* ---------- 数据 ---------- */
  function ensure() {
    if (IDX) return Promise.resolve(true);
    if (!PROMISE) {
      PROMISE = fetch('data/listening/index.json', { cache: 'no-cache' })
        .then((r) => r.json())
        .then((j) => { if (j && j.papers && j.papers.length) { IDX = j; return true; } return false; })
        .catch(() => { PROMISE = null; return false; });
    }
    return PROMISE;
  }

  function loadPaper(id) {
    if (paperData && paper && paper.id === id) return Promise.resolve(paperData);
    return fetch('data/listening/' + id + '.json', { cache: 'no-cache' })
      .then((r) => r.json())
      .then((j) => { paperData = j; return j; })
      .catch(() => null);
  }

  function lState() {
    if (!state.listen || typeof state.listen !== 'object') state.listen = { done: {}, vocab: {} };
    if (!state.listen.done) state.listen.done = {};
    if (!state.listen.vocab) state.listen.vocab = {};
    return state.listen;
  }

  function words() {
    if (!wordMap) {
      wordMap = new Map();
      (DATA.units || []).forEach((u) => (u.words || []).forEach((w) => {
        if (!wordMap.has(w.w.toLowerCase())) wordMap.set(w.w.toLowerCase(), { unit: u.id, w });
      }));
    }
    return wordMap;
  }

  function stats() {
    const l = lState();
    const ids = Object.keys(l.done);
    let ans = 0, cor = 0;
    ids.forEach((k) => { ans += l.done[k].answered || 0; cor += l.done[k].correct || 0; });
    const totalGroups = IDX ? IDX.papers.reduce((s, p) => s + (p.groups || 0), 0) : 0;
    return {
      groups: ids.length, totalGroups,
      answered: ans, correct: cor,
      pct: ans ? Math.round(cor / ans * 100) : 0,
      streak: streakFrom(practiceDays()),
    };
  }

  /* ---------- 首页卡片 ---------- */
  function renderHome() {
    const sub = $('#listening-card-sub'), pct = $('#listening-card-pct');
    if (!sub) return;
    const s = stats();
    if (s.groups) {
      sub.textContent = `已练 ${s.groups} 段 · 正确率 ${s.pct}%` + (s.streak > 1 ? ` · 连刷 ${s.streak} 天` : '');
      pct.textContent = s.pct + '%';
      pct.classList.remove('hidden');
    } else {
      sub.textContent = '真题 36 套 · 逐段逐句 · 先听后看';
      pct.classList.add('hidden');
    }
  }

  /* ---------- 页面骨架 ---------- */
  function renderStats() {
    const box = $('#ls-stats');
    if (!box) return;
    const s = stats();
    box.innerHTML = `<div class="rs-item"><b>${s.groups}</b><span>已练段</span></div>
      <div class="rs-item"><b>${s.answered ? s.pct + '%' : '—'}</b><span>正确率</span></div>
      <div class="rs-item"><b>${s.streak}</b><span>连刷天数</span></div>
      <div class="rs-item"><b>${s.totalGroups}</b><span>总段数</span></div>`;
  }

  function renderPage() {
    renderStats();
    ensure().then((ok) => {
      if (!ok) { $('#ls-body').innerHTML = '<div class="set-note">题库索引加载失败，请联网重试。</div>'; return; }
      renderPapers();
    });
  }

  function setTitle(t) { const el = $('#ls-title'); if (el) el.textContent = t; }

  function renderPapers() {
    paper = null; paperData = null; task = null; stopAudio();
    setTitle('六级听力精听');
    const l = lState();
    const body = $('#ls-body');
    body.innerHTML = '<div class="set-note" style="margin:10px 2px 6px">' +
      '按年份倒序 · 点开一套 → 选一段精听 · 音频按需下载</div>' +
      IDX.papers.map((p) => {
        const done = (paperDoneCount(p.id, l));
        const badge = done ? `<span class="ls-badge">${done}/${p.groups}</span>` : '';
        return `<div class="ls-paper" data-paper="${p.id}">
          <div class="ls-paper-main">
            <div class="ls-paper-title">${esc(p.title || p.id)}</div>
            <div class="ls-paper-sub">${p.groups} 段 · ${p.questionCount} 题 · ${p.sentences} 句</div>
          </div>${badge}</div>`;
      }).join('');
    body.querySelectorAll('[data-paper]').forEach((el) => el.addEventListener('click', () => openPaper(el.dataset.paper)));
    window.scrollTo({ top: 0 });
  }

  function paperDoneCount(pid, l) {
    let n = 0;
    Object.keys(l.done).forEach((k) => { if (k.indexOf('-' + pid + '-') > 0) n++; });
    return n;
  }

  function openPaper(id) {
    const meta = IDX.papers.find((p) => p.id === id);
    setTitle(meta ? (meta.title || id) : id);
    $('#ls-body').innerHTML = '<div class="set-note">加载中…</div>';
    loadPaper(id).then((d) => {
      if (!d) { $('#ls-body').innerHTML = '<div class="set-note">这一套加载失败，请联网重试。</div>'; return; }
      paper = meta || { id, title: id };
      renderGroups();
    });
  }

  function renderGroups() {
    task = null; stopAudio();
    const l = lState();
    const body = $('#ls-body');
    const secs = {};
    paperData.tasks.forEach((t) => { (secs[t.section || '其他'] = secs[t.section || '其他'] || []).push(t); });
    body.innerHTML = Object.keys(secs).map((sec) => `
      <div class="set-section-title">${esc(sec)}</div>
      ${secs[sec].map((t) => {
        const rec = l.done[t.id];
        const qn = t.questions.length;
        const st = rec ? `已答 ${rec.answered}/${qn} · 对 ${rec.correct}` : `${qn} 题 · ${t.lines.length} 句`;
        return `<div class="ls-group" data-task="${t.id}">
          <div class="ls-group-main">
            <div class="ls-group-title">${esc(t.title || t.id)}</div>
            <div class="ls-group-sub">${st}</div>
          </div>
          <div class="ls-group-mark ${rec && rec.answered >= qn ? (rec.correct >= rec.answered * 0.6 ? 'ok' : 'no') : ''}">
            ${rec && rec.answered >= qn ? (rec.correct >= rec.answered * 0.6 ? '✓' : '✗') : '›'}</div>
        </div>`;
      }).join('')}`).join('') + `
      <div class="ls-actions">
        <button class="ghost-btn" id="ls-prefetch">预下载本套音频（离线可听）</button>
      </div>
      <div class="set-note" id="ls-prefetch-note"></div>`;
    body.querySelectorAll('[data-task]').forEach((el) => el.addEventListener('click', () => {
      const t = paperData.tasks.find((x) => x.id === el.dataset.task);
      if (t) openTask(t);
    }));
    const pf = $('#ls-prefetch');
    if (pf) pf.addEventListener('click', prefetchPaper);
    window.scrollTo({ top: 0 });
  }

  /* ---------- 预下载（离线） ---------- */
  function prefetchPaper() {
    if (!paperData) return;
    const note = $('#ls-prefetch-note');
    const files = paperData.tasks.map((t) => t.audio);
    let done = 0, fail = 0, bytes = 0;
    note.textContent = `预下载中… 0/${files.length}`;
    const one = (u) => fetch(u).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then((b) => { bytes += b.size; done++; })
      .catch(() => { fail++; });
    Promise.all(files.map(one)).then(() => {
      note.textContent = `已下载 ${done}/${files.length} 个音频（${(bytes / 1048576).toFixed(1)} MB）`
        + (fail ? ` · 失败 ${fail} 个` : ' · 离线可听');
    });
  }

  /* ---------- 精听页 ---------- */
  function openTask(t) {
    task = t; loopLine = -1; showEn = false; showCn = false; unlocked = false;
    setTitle(t.title || t.id);
    renderDrill();
    window.scrollTo({ top: 0 });
  }

  /* 统一取"页面上那只" <audio>：早期版本这里 new Audio() 另建了一只，
     导致 seek/循环操作的是隐藏元素、用户看到却没反应（已修） */
  function getAudio() {
    const el = document.querySelector('#ls-audio');
    if (el) {
      if (audio !== el) { audio = el; audio.dataset.bound = ''; }
      if (!audio.dataset.bound) {
        audio.dataset.bound = '1';
        audio.addEventListener('timeupdate', onTick);
        audio.addEventListener('ended', () => { loopLine = -1; updateLoopBtn(); });
        audio.addEventListener('play', () => { const b = $('#ls-play'); if (b) b.textContent = '❚❚ 暂停'; });
        audio.addEventListener('pause', () => { const b = $('#ls-play'); if (b) b.textContent = '▶ 播放'; });
      }
      return audio;
    }
    if (!audio) { audio = new Audio(); audio.preload = 'metadata'; }
    return audio;
  }
  function stopAudio() { const au = document.querySelector('#ls-audio'); if (au) { try { au.pause(); } catch (e) {} } loopLine = -1; }

  /* 音频以"整文件 Blob"喂给播放器：绕开 HTTP Range 与 SW 缓存的兼容坑，
     离线可听、点句 seek 必定生效；SW 仍会把文件缓存下来供下次秒开。 */
  function attachAudio(rel) {
    const au = getAudio();
    if (blobFor === rel && blobUrl) { au.src = blobUrl; return; }
    setHint('音频加载中…（首次需下载，之后离线可听）');
    fetch(rel).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then((b) => {
      if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }
      blobUrl = URL.createObjectURL(b);
      blobFor = rel;
      au.src = blobUrl;
      setHint('音频就绪 · ' + (b.size / 1048576).toFixed(1) + ' MB（已缓存，可离线听）');
    }).catch(() => setHint('音频下载失败，请联网后重进本段'));
  }
  function setHint(t) { const h = $('#ls-hint'); if (h) h.textContent = t; }

  function renderDrill() {
    const l = lState();
    const rec = l.done[task.id] || { picks: {} };
    const lines = task.lines;
    const body = $('#ls-body');
    body.innerHTML = `
      <div class="ls-player">
        <audio id="ls-audio" controls preload="metadata"></audio>
        <div class="ls-ctl">
          <button class="mini-btn" id="ls-back5">« 5s</button>
          <button class="mini-btn" id="ls-play">▶ 播放</button>
          <button class="mini-btn" id="ls-fwd5">5s »</button>
          <button class="mini-btn" id="ls-rate">1.0×</button>
          <button class="mini-btn" id="ls-loop">单句循环</button>
        </div>
        <div class="ls-toggles">
          <button class="mini-btn" id="ls-en">显示原文</button>
          <button class="mini-btn" id="ls-cn">显示中文</button>
        </div>
        <div class="set-note" id="ls-hint">先听；听不懂就点句重听，或开原文对照。</div>
      </div>
      <div class="ls-q-sec">
        <div class="set-section-title">题目</div>
        <div id="ls-qs"></div>
      </div>
      <div class="ls-tr-sec">
        <div class="set-section-title">听力原文 <span class="set-hint" id="ls-tr-hint"></span></div>
        <div id="ls-tr" class="hidden"></div>
      </div>
      <div class="ls-actions">
        <button class="primary-btn" id="ls-next">下一段 ›</button>
        <button class="ghost-btn" id="ls-to-groups">返回段列表</button>
      </div>`;
    const au = getAudio();
    au.playbackRate = rate;
    attachAudio(task.audio);
    renderQuestions();
    renderTranscript();
    bindDrill();
    updateLoopBtn();
    $('#ls-tr').classList.toggle('hidden', !showEn);
    $('#ls-en').textContent = showEn ? '隐藏原文' : '显示原文';
    $('#ls-cn').textContent = showCn ? '隐藏中文' : '显示中文';
    $('#ls-cn').disabled = false;
    updateTrHint();
  }

  function renderQuestions() {
    const l = lState();
    const rec = l.done[task.id] || { picks: {} };
    const box = $('#ls-qs');
    const cnOn = showCn; // 只看开关：unlocked 只表示"允许开"，隐藏必须真能藏掉
    box.innerHTML = task.questions.map((q) => {
      const pick = rec.picks ? rec.picks[q.n] : null;
      return `<div class="ls-q" data-q="${q.n}">
        <div class="ls-q-stem"><b>${q.n}.</b> ${esc(q.stem)}
          ${q.cn && cnOn ? `<span class="ls-q-cn">${esc(q.cn)}</span>` : ''}</div>
        <div class="ls-opts">${['A', 'B', 'C', 'D'].map((c) => {
          let cls = '';
          if (pick) {
            if (c === q.answer) cls = 'right';
            else if (c === pick) cls = 'wrong';
          }
          const ocn = (q.optionsCn && q.optionsCn[c]) || '';
          return `<button class="ls-opt ${cls}" data-q="${q.n}" data-opt="${c}" ${pick ? 'disabled' : ''}>
            <b>${c}</b> ${esc(q.options[c] || '')}${ocn && cnOn ? `<span class="ls-opt-cn">${esc(ocn)}</span>` : ''}</button>`;
        }).join('')}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.ls-opt').forEach((b) => b.addEventListener('click', () => pickQ(Number(b.dataset.q), b.dataset.opt)));
  }

  function pickQ(n, letter) {
    const q = task.questions.find((x) => x.n === n);
    if (!q) return;
    const l = lState();
    const rec = l.done[task.id] || (l.done[task.id] = { picks: {}, answered: 0, correct: 0, ts: 0 });
    if (!rec.picks) rec.picks = {};
    if (rec.picks[n]) return;                       // 已答过不重复计分
    rec.picks[n] = letter;
    rec.answered = Object.keys(rec.picks).length;
    rec.correct = task.questions.filter((x) => rec.picks[x.n] && rec.picks[x.n] === x.answer).length;
    rec.ts = Date.now();
    saveState();
    renderQuestions();
    // 答完本题即解锁中文（用户要求：答完题或手动打开才显示中文）
    unlocked = true;
    const allDone = rec.answered >= task.questions.length;
    if (allDone && !showCn) {                        // 整段答完，自动展开中文（手动关过则尊重用户选择）
      showCn = true;
      renderTranscript();
      $('#ls-cn').textContent = '隐藏中文';
      updateTrHint();
    }
    renderStats();
    renderHome();
    const res = `第 ${n} 题：${letter === q.answer ? '✓ 对了' : '✗ 错了，正确答案 ' + q.answer}`;
    toast(res);
  }

  /* ---------- 原文（逐句） ---------- */
  function renderTranscript() {
    const box = $('#ls-tr');
    if (!box) return;
    const cnOn = showCn; // 只看开关：unlocked 只表示"允许开"，隐藏必须真能藏掉
    box.innerHTML = task.lines.map((ln, i) => `
      <div class="ls-line" data-i="${i}">
        <span class="ls-line-t">${fmtTime(ln.start)}</span>
        <span class="ls-line-en">${markWords(ln.t)}</span>
        ${ln.cn && cnOn ? `<span class="ls-line-cn">${esc(ln.cn)}</span>` : ''}
      </div>`).join('');
    box.querySelectorAll('.ls-line').forEach((el) => el.addEventListener('click', (ev) => {
      if (ev.target.closest('.ls-w')) return;         // 点词交给词卡
      seekLine(Number(el.dataset.i));
    }));
    box.querySelectorAll('.ls-w').forEach((el) => el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showWord(el.dataset.w, el);
    }));
  }

  function markWords(text) {
    return esc(text).replace(/([A-Za-z][A-Za-z'’\-]*)/g, (m) => {
      const key = m.toLowerCase().replace(/[’']s$/, '');
      const hit = words().has(key);
      return `<span class="ls-w ${hit ? 'in-dict' : ''}" data-w="${esc(m)}">${m}</span>`;
    });
  }

  function fmtTime(t) {
    if (t == null) return '--:--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  const SEEK_BACK = 0.12;   // 回退一点点，避免切掉首音节
  const LINE_TOL = 0.3;     // 判定"当前句"的容差，需大于 SEEK_BACK，否则高亮会落到上一句

  function seekLine(i) {
    const ln = task.lines[i];
    if (!ln || ln.start == null) return;
    const au = getAudio();
    const at = Math.max(0, ln.start - SEEK_BACK);
    // 元数据未就绪时直接设 currentTime 会被丢弃（慢网/大文件必现）→ 挂到 loadedmetadata 上补做
    if (au.readyState >= 1) {
      try { au.currentTime = at; } catch (e) {}
      au.play().catch(() => {});
    } else {
      const once = () => {
        au.removeEventListener('loadedmetadata', once);
        try { au.currentTime = at; } catch (e) {}
        au.play().catch(() => {});
      };
      au.addEventListener('loadedmetadata', once);
      au.load();
    }
    setActiveLine(i);
  }

  function setActiveLine(i) {
    const box = $('#ls-tr');
    if (!box) return;
    box.querySelectorAll('.ls-line.active').forEach((el) => el.classList.remove('active'));
    const el = box.querySelector(`.ls-line[data-i="${i}"]`);
    if (el) el.classList.add('active');
  }

  function onTick() {
    const au = getAudio();
    if (!task) return;
    const t = au.currentTime;
    // 单句循环
    if (loopLine >= 0) {
      const ln = task.lines[loopLine];
      if (ln && ln.end != null && t >= ln.end) {
        try { au.currentTime = Math.max(0, (ln.start || 0) - SEEK_BACK); } catch (e) {}
        return;
      }
    }
    // 高亮当前句
    let cur = -1;
    for (let i = 0; i < task.lines.length; i++) {
      const st = task.lines[i].start;
      if (st != null && t >= st - LINE_TOL) cur = i; else break;
    }
    if (cur >= 0) setActiveLine(cur);
  }

  function updateLoopBtn() {
    const b = $('#ls-loop');
    if (!b) return;
    b.textContent = loopLine >= 0 ? `循环中：第 ${loopLine + 1} 句 ✕` : '单句循环';
    b.classList.toggle('on', loopLine >= 0);
  }

  function updateTrHint() {
    const h = $('#ls-tr-hint');
    if (!h) return;
    h.textContent = showCn ? '点句重听 · 点词看释义/收藏' : '点句重听 · 点词看释义';
  }

  /* ---------- 词卡 ---------- */
  function showWord(raw, el) {
    const key = raw.toLowerCase().replace(/[^a-z'’\-]/g, '').replace(/[’']s$/, '');
    const hit = words().get(key);
    const l = lState();
    const faved = !!l.vocab[key];
    const box = $('#ls-wordcard');
    if (box) box.remove();
    const card = document.createElement('div');
    card.id = 'ls-wordcard';
    card.className = 'ls-wordcard';
    if (hit) {
      const cn = (hit.w.defs || []).map((d) => d.cn).join('；');
      card.innerHTML = `<div class="lw-head"><b>${esc(hit.w.w)}</b>
          <span class="lw-ph">${esc(hit.w.ph || '')}</span>
          <button class="vw-fav ${faved ? 'on' : ''}" data-lw="${esc(hit.w.w)}" data-cn="${esc(cn)}">${faved ? '★' : '☆'}</button>
          <button class="lw-close">✕</button></div>
        <div class="lw-cn">${esc(cn)}</div>
        <div class="lw-root">${esc((hit.w.root || '').slice(0, 90))}</div>`;
    } else {
      card.innerHTML = `<div class="lw-head"><b>${esc(raw)}</b><button class="lw-close">✕</button></div>
        <div class="lw-cn">词库（1007 词）里没有这个词，先按发音记一下。</div>`;
    }
    document.body.appendChild(card);
    const rect = el.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 170, rect.bottom + 8 + window.scrollY);
    card.style.top = Math.max(8, top) + 'px';
    card.style.left = Math.max(8, Math.min(window.innerWidth - 300, rect.left - 20)) + 'px';
    speak(raw.replace(/[^A-Za-z'’\-]/g, ''));
    card.querySelector('.lw-close').addEventListener('click', () => card.remove());
    const fav = card.querySelector('[data-lw]');
    if (fav) fav.addEventListener('click', () => {
      const w = fav.dataset.lw;
      if (l.vocab[w.toLowerCase()]) { delete l.vocab[w.toLowerCase()]; if (typeof Sync !== 'undefined') Sync.tomb('lv:' + w.toLowerCase()); fav.classList.remove('on'); fav.textContent = '☆'; toast('已取消收藏'); }
      else { l.vocab[w.toLowerCase()] = { cn: fav.dataset.cn, ts: Date.now() }; if (typeof Sync !== 'undefined') Sync.untomb('lv:' + w.toLowerCase()); fav.classList.add('on'); fav.textContent = '★'; toast('已收藏到收藏夹·听力生词'); }
      saveState();
    });
  }

  /* ---------- 交互绑定 ---------- */
  function bindDrill() {
    const au = getAudio();
    $('#ls-play').addEventListener('click', () => {
      if (au.paused) au.play().catch(() => toast('音频还没下好，稍等再点')); else au.pause();
    });
    $('#ls-back5').addEventListener('click', () => { au.currentTime = Math.max(0, au.currentTime - 5); });
    $('#ls-fwd5').addEventListener('click', () => { au.currentTime = Math.min(au.duration || 1e9, au.currentTime + 5); });
    $('#ls-rate').addEventListener('click', () => {
      rate = rate === 1 ? 0.75 : rate === 0.75 ? 1.25 : 1;
      au.playbackRate = rate;
      $('#ls-rate').textContent = rate.toFixed(2).replace(/0$/, '') + '×';
    });
    $('#ls-loop').addEventListener('click', () => {
      const active = $('#ls-tr .ls-line.active');
      if (loopLine >= 0) { loopLine = -1; }
      else if (active) { loopLine = Number(active.dataset.i); seekLine(loopLine); }
      else { toast('先点一句原文再开循环'); return; }
      updateLoopBtn();
    });
    $('#ls-en').addEventListener('click', () => {
      showEn = !showEn;
      $('#ls-tr').classList.toggle('hidden', !showEn);
      $('#ls-en').textContent = showEn ? '隐藏原文' : '显示原文';
      if (showEn && !$('#ls-tr').innerHTML) renderTranscript();
    });
    $('#ls-cn').addEventListener('click', () => {
      showCn = !showCn;
      if (showCn) unlocked = true;                 // 手动打开即解锁
      renderQuestions(); renderTranscript(); updateTrHint();
      $('#ls-cn').textContent = showCn ? '隐藏中文' : '显示中文';
      if (showCn) toast('中文已展开（练完再关掉更有效）');
    });
    $('#ls-to-groups').addEventListener('click', () => { stopAudio(); renderGroups(); });
    $('#ls-next').addEventListener('click', () => {
      const i = paperData.tasks.findIndex((t) => t.id === task.id);
      const nxt = paperData.tasks[i + 1];
      if (nxt) { stopAudio(); openTask(nxt); } else { toast('这一套练完了 🎉'); stopAudio(); renderGroups(); }
    });
  }

  function bind() {
    const card = $('#listening-card');
    if (card) card.addEventListener('click', () => nav('listening'));
    const back = $('#ls-back');
    if (back) back.addEventListener('click', () => {
      if (task) { stopAudio(); renderGroups(); }
      else if (paperData) renderPapers();
      else nav('units');
    });
    const cb = $('#ls-cache-btn');
    if (cb) cb.addEventListener('click', showCache);
  }

  /* ---------- 缓存信息 / 清理 ---------- */
  function showCache() {
    const jobs = [];
    if (navigator.storage && navigator.storage.estimate) {
      jobs.push(navigator.storage.estimate().then((e) => {
        const used = (e.usage || 0) / 1048576, quota = (e.quota || 0) / 1048576;
        return `本应用已占 ${used.toFixed(1)} MB（可用上限约 ${quota.toFixed(0)} MB）`;
      }));
    }
    jobs.push(caches.keys().then((ks) => '缓存区：' + (ks.filter((k) => k.indexOf('sgwd-audio') === 0).length ? '有音频缓存' : '暂无音频缓存')));
    Promise.all(jobs).then((msgs) => {
      if (confirm(msgs.join('\n') + '\n\n是否清理已下载的音频缓存？（不影响学习进度）')) {
        caches.keys().then((ks) => Promise.all(ks.filter((k) => k.indexOf('sgwd-audio') === 0).map((k) => caches.delete(k))))
          .then(() => toast('音频缓存已清理'));
      }
    });
  }

  /* ---------- 收藏夹：听力生词折叠分区 ---------- */
  function renderWrongVocab() {
    const box = $('#fav-listen-list');
    if (!box) return;
    const wrap = $('#fav-listen-box');
    const head = $('#fav-listen-head');
    const l = lState();
    const ws = Object.keys(l.vocab);
    if (wrap) wrap.classList.toggle('hidden', !ws.length); // 没收藏就整块藏起来
    if (head) head.textContent = `🎧 听力生词（${ws.length}）`;
    if (!ws.length) return;
    box.innerHTML = ws.map((w) => `
      <div class="rem-item"><div><div>${esc(w)}</div><div class="rem-when">${esc(l.vocab[w].cn || '')}</div></div>
      <button class="rem-del" data-lvw="${esc(w)}">认识</button></div>`).join('');
    box.querySelectorAll('[data-lvw]').forEach((b) => b.addEventListener('click', () => {
      delete lState().vocab[b.dataset.lvw];
      if (typeof Sync !== 'undefined') Sync.tomb('lv:' + b.dataset.lvw);
      saveState(); renderWrongVocab();
    }));
  }

  return { ensure, renderHome, renderPage, renderWrongVocab, bind, stats, showCache };
})();

/* ================= 提醒（Web Push） ================= */
const Reminder = (() => {
  const DEFAULT_API = 'https://qinfweihe1-d5gxpjjli9f8f238b.service.tcloudbase.com/api';
  let API = localStorage.getItem('sgwd_api') || DEFAULT_API;
  if (!API || /deno\.(dev|net)/.test(API)) API = DEFAULT_API; // Deno 后端已停用，迁移到 CloudBase

  function rem() {
    if (!state.reminder) state.reminder = { id: '', enabled: false, time: '20:00', smart: true, custom: [] };
    return state.reminder;
  }

  function isStandalone() {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  }

  function setStatus(msg, cls) {
    const el = $('#rem-status');
    if (el) {
      el.textContent = msg;
      el.className = 'set-note' + (cls ? ' ' + cls : '');
    }
    // 待办页状态条同步显示（该页操作时设置页不可见）
    const sub2 = $('#todo-rem-sub');
    if (sub2) sub2.textContent = msg;
  }

  async function api(path, opts) {
    // 兼容旧签名：转成 CloudBase 动作调用（path 即 action 名）
    return Sync.request(path, opts && opts.body ? JSON.parse(opts.body) : {});
  }

  /** 上报服务端的提醒设置（时间/智能/开关/活跃度） */
  function settingsPayload() {
    const r = rem();
    let learnedTotal = 0;
    for (const k in state.learned) learnedTotal += countKeys(state.learned, k);
    return { time: r.time || '20:00', smart: r.smart !== false, enabled: !!r.enabled, lastActive: Date.now(), learnedTotal };
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  /** 订阅的 applicationServerKey 是否与当前后端的 VAPID 公钥一致
   * （换后端后旧订阅是用旧密钥建的，苹果会直接拒收新服务器的推送） */
  function sameAppServerKey(sub, pubB64) {
    try {
      const cur = sub && sub.options && sub.options.applicationServerKey;
      if (!cur) return false;
      const a = new Uint8Array(cur);
      const b = urlBase64ToUint8Array(pubB64);
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    } catch (e) { return false; }
  }

  /** 拿到与当前后端匹配的订阅（不一致就作废重建） */
  async function ensureFreshSub() {
    const reg = await navigator.serviceWorker.ready;
    const pk = await Sync.request('pubkey', {});
    let sub = await reg.pushManager.getSubscription();
    let rebuilt = false;
    if (sub && !sameAppServerKey(sub, pk.publicKey)) {
      try { await sub.unsubscribe(); } catch (e) { /* 忽略 */ }
      sub = null;
      rebuilt = true;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(pk.publicKey) });
    }
    return { sub, rebuilt };
  }

  /** 启动自愈：已开提醒但订阅还是旧服务器密钥建的 → 静默重建并重传 */
  async function repairPush() {
    try {
      if (!rem().enabled) return;
      if (!pushSupported() || !isStandalone()) return;
      if (Notification.permission !== 'granted') return;
      if (!state.sync || !state.sync.code) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return; // 没有订阅就不自动创建（安卓上创建必失败，交给 enable 流程按需处理）
      const pk = await Sync.request('pubkey', {});
      if (sameAppServerKey(sub, pk.publicKey)) return; // 正常，不动
      const r1 = await withTimeout(ensureFreshSub(), 9000);
      await Sync.request('subscribe', { subscription: r1.sub.toJSON(), ua: String(navigator.userAgent).slice(0, 100) });
      setStatus('已自动修复推送订阅（换服务器导致的密钥不匹配）✓', 'ok');
    } catch (e) { /* 静默，不打扰 */ }
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('订阅超时（网络不通）')), ms))]);
  }

  /** 开启每日提醒：iPhone 走系统通知、安卓走 ntfy —— 两条通道至少有一条能用即可开启 */
  async function enable() {
    try {
      setStatus('正在开启…');
      await Sync.ensureOn(); // 提醒需要云身份（自动开通云同步）
      const ntfyOn = !!(state.sync && state.sync.ntfyTopic);
      let pushOK = false, why = '';
      if (pushSupported() && isStandalone()) {
        try {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            const { sub } = await withTimeout(ensureFreshSub(), 9000); // 密钥不符会重建；安卓订阅不了会超时
            await Sync.request('subscribe', { subscription: sub.toJSON(), ua: String(navigator.userAgent).slice(0, 100) });
            pushOK = true;
          } else { why = '通知权限没允许'; }
        } catch (e) { why = String((e && e.message) || e).slice(0, 40); }
      } else if (!pushSupported()) {
        why = '这个浏览器不支持系统通知';
      } else {
        why = '还没把本应用「添加到主屏幕」';
      }
      if (!pushOK && !ntfyOn && !state.sync.pushplusToken && !Sync.isShell()) {
        setStatus('这台设备现在还收不到提醒（' + why + '）。安卓手机可以：装「📲 安卓 App 安装包」（最省心），或到下面「💬 微信通知」粘贴 PushPlus 口令；iPhone 请先「添加到主屏幕」并从主屏图标打开、允许通知。', 'err');
        return false;
      }
      rem().enabled = true;
      saveState();
      const enEl = $('#rem-enabled');
      if (enEl) enEl.checked = true;
      const shell = Sync.isShell();
      setStatus('提醒已开启 ✓ 每天 ' + (rem().time || '20:00') + ' · 通道：' + [pushOK ? '系统通知' : '', ntfyOn ? 'ntfy' : '', state.sync.pushplusToken ? '微信' : '', shell ? 'App 通知' : ''].filter(Boolean).join(' + '), 'ok');
      sync(true);
      return true;
    } catch (e) {
      setStatus('开启失败：' + String(e).slice(0, 80), 'err');
      return false;
    }
  }

  async function disable() {
    rem().enabled = false;
    saveState();
    const enEl = $('#rem-enabled');
    if (enEl) enEl.checked = false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) { /* ignore */ }
    setStatus('提醒已关闭', '');
    sync(true);
    return true;
  }

  /** 把提醒设置推给服务端（节流）*/
  let syncTimer = null;
  function sync(now) {
    if (!state.sync || !state.sync.code) return;
    clearTimeout(syncTimer);
    const doIt = () => Sync.request('reminder.set', settingsPayload()).catch(() => {});
    now ? doIt() : (syncTimer = setTimeout(doIt, 1500));
  }

  /** 学习状态上报（供智能模式判断"今天是否已背过"）—— 走云同步的 meta 域 */
  function ping() {
    if (typeof Sync !== 'undefined') Sync.markDirty();
  }

  async function sendTest() {
    if (!state.sync || !state.sync.code) { setStatus('先在下方「云同步」里开启（开启提醒会自动开通）', 'warn'); return; }
    if (Sync.isShell()) {
      try { window.vfShell.testNotify(); setStatus('已让 App 弹一条测试通知（几秒内到）', 'ok'); return; } catch (e) { /* 落回服务端测试 */ }
    }
    setStatus('正在发送测试通知…');
    try {
      const r = await Sync.request('testpush', {});
      const push = (r && r.push) || {};
      const ntfy = (r && r.ntfy) || {};
      const first = (push.results || [])[0] || {};
      const pushSent = push.sent || 0;
      const chans = [pushSent > 0 ? '系统通知' : '', ntfy.published ? 'ntfy' : ''].filter(Boolean);
      if (chans.length) {
        setStatus('测试通知已发出（' + chans.join(' + ') + '），几秒内到', 'ok');
      } else if (!(state.sync && state.sync.ntfyTopic)) {
        setStatus('这台设备两条通道都还没配：安卓请到「📱 安卓通知(ntfy)」生成主题并在 ntfy App 里订阅；iPhone 请重新开启上面的提醒开关', 'err');
      } else if (push.total > 0 && first.status === 403) {
        setStatus('苹果拒收（订阅是旧服务器密钥建的）——关掉再打开上面的开关即可自动修复', 'err');
      } else {
        setStatus('发送失败：' + String(first.error || (ntfy.error || '') || JSON.stringify(first)).slice(0, 90), 'err');
      }
    } catch (e) {
      setStatus('测试失败：' + String(e.message || e).slice(0, 80), 'err');
    }
  }

  /** 初始化 UI 事件（设置页加载后调用） */
  function init() {
    const r = rem();
    const en = $('#rem-enabled');
    if (!en) return;
    en.checked = !!r.enabled;
    $('#rem-time').value = r.time || '20:00';
    $('#rem-smart').checked = r.smart !== false;

    en.addEventListener('change', async () => {
      if (en.checked) {
        const ok = await enable();
        en.checked = !!ok;
      } else {
        await disable();
      }
    });
    $('#rem-time').addEventListener('change', (e) => { rem().time = e.target.value || '20:00'; saveState(); sync(); });
    $('#rem-smart').addEventListener('change', (e) => { rem().smart = e.target.checked; saveState(); sync(); });
    $('#rem-test').addEventListener('click', sendTest);
    // 后端地址输入框由 Sync 模块统一接管（两个模块共用同一地址）
    if (r.enabled && state.sync && state.sync.code) setStatus('提醒已开启 ✓ 每天 ' + (r.time || '20:00') + (r.smart !== false ? '（已背过则跳过）' : ''), 'ok');
    else if (!isStandalone()) setStatus('提示：先「添加到主屏幕」，从主屏图标打开后再开启提醒', '');
    if (r.enabled) repairPush(); // 启动自愈：旧订阅密钥不匹配时自动重建（换后端后必备）
  }

  return { init, ping, sync, isStandalone, pushSupported, enable, disable, sendTest, repairPush };
})();

/* ================= Service Worker（https 环境下离线可用；http 下静默跳过） ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // 新版本 SW 接管后自动刷新一次，保证用户拿到最新页面/词表
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}

/* ================= 离线词典（ECDICT 精选 1.8 万学习词，按首字母分片懒加载） ================= */
const Dict = (() => {
  const cache = {};
  const loading = {};
  function load(letter) {
    if (cache[letter]) return Promise.resolve(cache[letter]);
    if (!loading[letter]) {
      loading[letter] = fetch('data/dict/' + letter + '.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : {}))
        .then((j) => { cache[letter] = j || {}; return cache[letter]; })
        .catch(() => { cache[letter] = {}; return cache[letter]; });
    }
    return loading[letter];
  }
  async function lookup(word) {
    const w = String(word || '').toLowerCase().replace(/[^a-z'\-]/g, '');
    if (!w || w.length > 24) return null;
    const ch = await load(w[0]);
    const e = ch[w];
    if (e) return { w, p: e.p, c: e.c };
    // 所有格兜底：anybody's → anybody
    if (w.endsWith("'s") && w.length > 3) {
      const base = w.slice(0, -2);
      const e2 = ch[base];
      if (e2) return { w: base, p: e2.p, c: e2.c };
    }
    return null;
  }
  async function suggest(prefix, limit) {
    const p = String(prefix || '').toLowerCase().replace(/[^a-z'\-]/g, '');
    if (!p || p.length < 2) return [];
    const ch = await load(p[0]);
    const out = [];
    for (const k of Object.keys(ch)) {
      if (k !== p && k.startsWith(p)) { out.push({ w: k, p: ch[k].p, c: ch[k].c }); if (out.length >= (limit || 8)) break; }
    }
    out.sort((a, b) => a.w.length - b.w.length); // 短词（更常用）在前
    return out.slice(0, limit || 8);
  }
  return { lookup, suggest };
})();

/* ================= 词卡弹层（阅读点词 / 搜索查词共用） ================= */
const WordCard = (() => {
  let el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'word-card';
    el.innerHTML = `
      <div class="wcmask"></div>
      <div class="wcsheet">
        <div class="wchead"><span class="wcword"></span><button class="wcclose">✕</button></div>
        <div class="wcphon"></div>
        <div class="wccn"></div>
        <div class="wcacts">
          <button class="wcbtn wcspeak">🔊 发音</button>
          <button class="wcbtn wcfav">☆ 收藏生词</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.wcmask').addEventListener('click', hide);
    el.querySelector('.wcclose').addEventListener('click', hide);
    el.querySelector('.wcspeak').addEventListener('click', () => { if (el.dataset.w) speak(el.dataset.w); });
    el.querySelector('.wcfav').addEventListener('click', toggleFav);
    return el;
  }
  function inVocab(w) {
    return !!(state.reading && state.reading.vocab && state.reading.vocab[w]);
  }
  function toggleFav() {
    if (!el || !el.dataset.w) return;
    const w = el.dataset.w;
    if (!state.reading || typeof state.reading !== 'object') state.reading = {};
    if (!state.reading.vocab) state.reading.vocab = {};
    const btn = el.querySelector('.wcfav');
    if (state.reading.vocab[w]) {
      delete state.reading.vocab[w];
      if (typeof Sync !== 'undefined') Sync.tomb('rv:' + w);
      btn.textContent = '☆ 收藏生词';
      btn.classList.remove('on');
      toast('已取消收藏');
    } else {
      state.reading.vocab[w] = { cn: el.dataset.cn || '', ts: Date.now() };
      if (typeof Sync !== 'undefined') Sync.untomb('rv:' + w);
      btn.textContent = '★ 已收藏';
      btn.classList.add('on');
      toast('已收藏到收藏夹·阅读生词');
    }
    saveState();
    if (typeof Reading !== 'undefined' && currentView === 'favorites') Reading.renderWrongVocab();
  }
  async function show(word) {
    const box = ensure();
    const w = String(word || '').toLowerCase().replace(/[^a-z'\-]/g, '');
    if (!w) return;
    box.dataset.w = w;
    box.dataset.cn = '';
    box.querySelector('.wcword').textContent = w;
    box.querySelector('.wcphon').textContent = '…';
    box.querySelector('.wccn').textContent = '';
    const faved = inVocab(w);
    const fav = box.querySelector('.wcfav');
    fav.classList.toggle('on', faved);
    fav.textContent = faved ? '★ 已收藏' : '☆ 收藏生词';
    box.classList.add('open');
    const e = await Dict.lookup(w);
    if (box.dataset.w !== w) return; // 期间已切到别的词
    if (e) {
      box.querySelector('.wcphon').textContent = e.p || '';
      box.querySelector('.wccn').textContent = e.c;
      box.dataset.cn = e.c;
    } else {
      box.querySelector('.wcphon').textContent = '';
      box.querySelector('.wccn').textContent = '词典暂未收录，仍可发音与收藏。';
    }
  }
  function hide() { if (el) el.classList.remove('open'); }
  return { show, hide };
})();

/* ================= 搜索 & 继续学习 ================= */
let searchSeq = 0;
async function renderSearch(q) {
  const box = $('#search-results');
  const seq = ++searchSeq;
  q = q.trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const hits = [];
  for (const u of DATA.units) {
    for (let i = 0; i < u.words.length; i++) {
      const w = u.words[i];
      const cn = w.defs.map((x) => x.cn).join(' ');
      if (w.w.toLowerCase().includes(q) || cn.includes(q)) {
        hits.push({ u, idx: i, w });
        if (hits.length >= 40) break;
      }
    }
    if (hits.length >= 40) break;
  }
  let html = '';
  if (hits.length) {
    html += '<div class="sr-sec">应用词库 · 点击去学习</div>' + hits.map((h) => `
    <div class="sr-item" data-unit="${h.u.id}" data-idx="${h.idx}">
      <div><span class="sr-word">${h.w.w}</span><span class="sr-unit">${h.u.name}</span></div>
      <div class="sr-cn">${(h.w.defs[0] && h.w.defs[0].cn) || ''}</div>
    </div>`).join('');
  }
  // 离线词典：任意英文词都能查（精确 + 前缀建议）
  if (/^[a-z][a-z'\-]*$/.test(q)) {
    const exact = await Dict.lookup(q);
    if (seq !== searchSeq) return;
    const dictRows = [];
    if (exact && !hits.some((h) => h.w.w.toLowerCase() === exact.w)) dictRows.push(exact);
    const sugs = await Dict.suggest(q, 8);
    if (seq !== searchSeq) return;
    for (const s of sugs) {
      if (s.w !== q && !dictRows.some((d) => d.w === s.w) && !hits.some((h) => h.w.w.toLowerCase() === s.w)) dictRows.push(s);
    }
    if (dictRows.length) {
      html += '<div class="sr-sec">词典 · 点击看释义</div>' + dictRows.map((d) => `
        <div class="sr-item sr-dict" data-dw="${d.w}">
          <div><span class="sr-word">${d.w}</span>${d.p ? `<span class="sr-phon">${d.p}</span>` : ''}</div>
          <div class="sr-cn">${d.c}</div>
        </div>`).join('');
    }
  }
  if (!html) {
    box.innerHTML = '<div class="sr-empty">没有找到相关单词</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = html;
  box.classList.remove('hidden');
}

$('#search-input').addEventListener('input', (e) => renderSearch(e.target.value));
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});
$('#search-results').addEventListener('click', (e) => {
  const d = e.target.closest('.sr-dict');
  if (d) { WordCard.show(d.dataset.dw); return; }
  const item = e.target.closest('.sr-item');
  if (!item) return;
  $('#search-input').value = '';
  $('#search-results').classList.add('hidden');
  gotoWord(Number(item.dataset.unit), Number(item.dataset.idx));
});

function renderContinue() {
  const b = $('#btn-continue');
  const u = state.lastUnit && unitById(state.lastUnit);
  if (u) {
    const l = countKeys(state.learned, u.id);
    const rec = state.scrolls && state.scrolls[String(u.id)];
    let pos = '';
    if (rec && typeof rec === 'object' && rec.w) {
      const idx = u.words.findIndex((x) => wordKey(x.w) === rec.w);
      if (idx > 0) pos = ` · 第 ${idx + 1} 词`;
    }
    b.textContent = `继续学习 · ${u.name}${pos}（已学 ${l}/${u.words.length}）`;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}
$('#btn-continue').addEventListener('click', () => {
  if (state.lastUnit) openStudy(state.lastUnit);
});

/* ================= 今日任务 & 学习热力图 ================= */
function renderToday() {
  const sub = $('#today-sub');
  const badge = $('#today-badge');
  if (!sub) return;
  const c = dailyCfg();
  const due = srsDueCapped().length;
  const t = todayCount();
  const parts = [];
  if (c.newWords.on) parts.push(`新词 ${t.n}/${c.newWords.goal}`);
  if (c.review.on) parts.push(`待复习 ${due}`);
  if (c.reading.on) parts.push(`阅读 ${readingDoneToday()}/${c.reading.goal}`);
  if (c.listening.on) parts.push(`听力 ${listeningDoneToday()}/${c.listening.goal}`);
  const dt = dailyTasks();
  if (dt.length) parts.push(`事项 ${dailyDoneCount()}/${dt.length}`);
  sub.textContent = parts.length ? parts.join(' · ') : '点右上角 ⚙ 配置你今天的目标';
  badge.textContent = due > 0 ? String(due) : '✓';
  badge.classList.remove('hidden');
  badge.classList.toggle('today-clear', due === 0 && (dt.length ? dailyDoneCount() === dt.length : true));
  renderTodayList();
}

function renderTodayList() {
  const box = $('#today-list');
  if (!box) return;
  const c = dailyCfg();
  const rows = [];
  if (c.newWords.on) {
    const t = todayCount();
    const ok = t.n >= c.newWords.goal;
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-go="newword"><span class="ti-ico">${ok ? '✅' : '📖'}</span><span class="ti-text">背新词</span><span class="ti-num">${t.n}/${c.newWords.goal}</span></div>`);
  }
  if (c.review.on) {
    const due = srsDueCapped().length;
    rows.push(`<div class="today-item ${due === 0 ? 'done' : ''}" data-go="review"><span class="ti-ico">${due === 0 ? '✅' : '🔁'}</span><span class="ti-text">复习到期词</span><span class="ti-num">${due}${c.review.cap > 0 && srsDueList().length > c.review.cap ? '（总' + srsDueList().length + '，今日上限' + c.review.cap + '）' : ''}</span></div>`);
  }
  if (c.reading.on) {
    const n = readingDoneToday();
    const ok = n >= c.reading.goal;
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-go="reading"><span class="ti-ico">${ok ? '✅' : '📖'}</span><span class="ti-text">阅读随手练</span><span class="ti-num">${n}/${c.reading.goal}</span></div>`);
  }
  if (c.listening.on) {
    const n = listeningDoneToday();
    const ok = n >= c.listening.goal;
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-go="listening"><span class="ti-ico">${ok ? '✅' : '🎧'}</span><span class="ti-text">听力精听</span><span class="ti-num">${n}/${c.listening.goal}</span></div>`);
  }
  dailyTasks().forEach((t) => {
    const ok = dailyTaskDone(t);
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-dtask="${t.id}"><span class="ti-ico">${ok ? '✅' : '⬜'}</span><span class="ti-text">${esc(t.text)}</span><span class="ti-num">${ok ? '已完成' : '点一下打勾'}</span></div>`);
  });
  box.innerHTML = rows.join('');
  box.classList.toggle('hidden', !rows.length);
  box.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => {
    const g = el.dataset.go;
    if (g === 'newword') {
      if (state.lastUnit) openStudy(state.lastUnit);
      else toast('选一个单元开始背吧');
    } else if (g === 'review') {
      const q = srsDueCapped();
      if (!q.length) { toast('今日复习已清空 ✓'); return; }
      startTest(q, `今日复习 ${q.length} 词`);
    } else if (g === 'reading') nav('reading');
    else if (g === 'listening') nav('listening');
  }));
  box.querySelectorAll('[data-dtask]').forEach((el) => el.addEventListener('click', () => {
    const t = dailyTasks().find((x) => String(x.id) === el.dataset.dtask);
    if (!t) return;
    t.done = dailyTaskDone(t) ? '' : bjDayStr(); // 打勾/取消（次日自动未勾）
    t.doneTs = Date.now();
    saveState();
    renderToday();
  }));
}

/* ---------- 每日任务配置面板 ---------- */
function renderDailyCfg() {
  const body = $('#daily-cfg-body');
  if (!body) return;
  const c = dailyCfg();
  const row = (key, label, hint, goalKey, min, max, step) => `
    <div class="dcfg-row">
      <div class="dcfg-main">
        <div class="dcfg-label">${label}</div>
        <div class="set-hint">${hint}</div>
      </div>
      <input type="number" class="dcfg-num" data-cfg="${key}" data-field="${goalKey}" min="${min}" max="${max}" step="${step}" value="${c[key][goalKey]}">
      <label class="switch"><input type="checkbox" data-cfg-on="${key}" ${c[key].on ? 'checked' : ''}><span>${c[key].on ? '启用' : '关闭'}</span></label>
    </div>`;
  body.innerHTML =
    row('newWords', '背新词', '每天新学多少个词', 'goal', 5, 200, 5) +
    row('review', '复习到期词', '最多复习多少个（0=不限，防积压）', 'cap', 0, 500, 10) +
    row('reading', '阅读随手练', '每天几篇（做一篇自动打勾）', 'goal', 1, 10, 1) +
    row('listening', '听力精听', '每天几段（做一段自动打勾）', 'goal', 1, 10, 1);
  body.querySelectorAll('[data-cfg]').forEach((inp) => inp.addEventListener('change', () => {
    const key = inp.dataset.cfg, f = inp.dataset.field;
    let v = Math.round(Number(inp.value) || 0);
    v = Math.max(Number(inp.min), Math.min(Number(inp.max), v));
    inp.value = v;
    dailyCfg()[key][f] = v;
    dailyCfg()._ts = Date.now();
    saveState();
    renderToday();
  }));
  body.querySelectorAll('[data-cfg-on]').forEach((sw) => sw.addEventListener('change', () => {
    const key = sw.dataset.cfgOn;
    dailyCfg()[key].on = sw.checked;
    dailyCfg()._ts = Date.now();
    saveState();
    renderDailyCfg();
    renderToday();
  }));
  const tr = $('#daily-task-rows');
  if (tr) {
    const ts = dailyTasks();
    tr.innerHTML = ts.length
      ? ts.map((t) => `<div class="rem-item"><div><div>${esc(t.text)}</div><div class="rem-when">${dailyTaskDone(t) ? '今天已打勾' : '今天还没打勾'}</div></div><button class="rem-del" data-dtask-del="${t.id}">删除</button></div>`).join('')
      : '<div class="set-note">还没有自定义事项，下面加一条试试。</div>';
    tr.querySelectorAll('[data-dtask-del]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.dtaskDel;
      state.dailyTasks = dailyTasks().filter((x) => String(x.id) !== id);
      saveState();
      renderDailyCfg();
      renderToday();
    }));
  }
}
$('#today-cfg-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  renderDailyCfg();
  $('#daily-cfg-mask').classList.remove('hidden');
});
$('#daily-cfg-close').addEventListener('click', () => $('#daily-cfg-mask').classList.add('hidden'));
$('#daily-cfg-mask').addEventListener('click', (e) => { if (e.target.id === 'daily-cfg-mask') $('#daily-cfg-mask').classList.add('hidden'); });
$('#daily-task-add').addEventListener('click', () => {
  const el = $('#daily-task-input');
  const text = (el.value || '').trim();
  if (!text) { toast('先写点内容'); return; }
  dailyTasks().push({ id: 'dt' + Date.now().toString(36), text, done: '', doneTs: 0, createdAt: Date.now() });
  el.value = '';
  saveState();
  renderDailyCfg();
  renderToday();
});

$('#today-card').addEventListener('click', () => {
  const q = srsDueCapped();
  if (!q.length) { toast('今日复习已清空 ✓ 去完成清单里的其它任务吧'); return; }
  startTest(q, `今日复习 ${q.length} 词`);
});

function heatLevel(total) {
  if (!total) return 0;
  if (total < 10) return 1;
  if (total < 30) return 2;
  if (total < 60) return 3;
  return 4;
}

function renderHeat() {
  const grid = $('#heat-grid');
  if (!grid) return;
  const WEEKS = 12;
  const practice = practiceDays(); // 阅读/听力练过的日子（无词量计数，记 1 点活动）
  const today = bjDayStr();
  // 列=周（上行周一、下行周日）：终点 = 本周日，起点 = 11 周前的周一，共 84 格
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0=周一 … 6=周日
  const cells = [];
  for (let i = 77 + dow; i >= -(6 - dow); i--) {
    const ts = Date.now() + 8 * 3600e3 - i * 86400e3;
    const d = new Date(ts).toISOString().slice(0, 10);
    const total = dayTotal(d) + (practice.has(d) && !dayTotal(d) ? 1 : 0);
    cells.push({ d, total, future: d > today });
  }
  grid.innerHTML = cells.map((c) => c.future
    ? '<span class="heat-cell hidden-cell"></span>'
    : `<span class="heat-cell l${heatLevel(c.total)}" title="${c.d} · ${c.total ? c.total + ' 次学习' : '未学习'}"></span>`
  ).join('');
  // 本周统计（周一至今）
  let wn = 0, wr = 0, days = 0;
  for (let i = dow; i >= 0; i--) {
    const d = bjDayStr(Date.now() - i * 86400e3);
    const g = todayLog()[d] || {};
    wn += g.n || 0;
    wr += g.r || 0;
    if ((g.n || 0) + (g.r || 0) > 0 || practice.has(d)) days++;
  }
  const week = $('#heat-week');
  if (week) {
    week.textContent = `本周：新学 ${wn} 词 · 复习 ${wr} 词 · 打卡 ${days} 天 · 连续 ${streakFrom(practice)} 天`;
  }
}

/* ================= 启动 ================= */
// iOS Safari：挂一个 touch 监听后 :active 按压反馈才会生效
document.addEventListener('touchstart', () => {}, { passive: true });

async function boot() {
  // 阶段一：轻量索引，秒开首页
  try {
    const m = await (await fetch('data/meta.json', { cache: 'no-cache' })).json();
    META = m;
    $('#topbar-sub').textContent = (m.meta && m.meta.subtitle) || '';
  } catch (e) { /* 忽略，等全量 */ }

  // 版本号：设置页常显；检测到新版本弹一次提示
  try {
    const v = await (await fetch('version.json', { cache: 'no-cache' })).json();
    if (v && v.v) {
      const line = $('#ver-line');
      if (line) line.textContent = `当前版本 v${v.v} · 发布于 ${v.t || ''}`;
      const seen = localStorage.getItem('sgwd_seen_ver');
      if (seen && seen !== v.v) toast(`✨ 已更新到 v${v.v}`);
      localStorage.setItem('sgwd_seen_ver', v.v);
      // 安卓壳：比对安装包版本，有新版时红字提示重装（壳自己也会发系统通知）
      try {
        const sh = window.vfShell;
        const local = sh && typeof sh.apkVer === 'function' ? String(sh.apkVer() || '') : null;
        if (local !== null && v.apk && v.apk !== local) {
          const st = $('#apk-ver-state');
          if (st) {
            st.innerHTML = '⚠ 检测到 App 有新版本 <button class="ghost-btn" id="apk-update-now" style="padding:5px 14px">⬇️ 一键更新</button>';
            st.style.color = '#d84c4c';
            st.style.fontWeight = '700';
            const ub = $('#apk-update-now');
            if (ub) ub.addEventListener('click', () => {
              try {
                const sh = window.vfShell;
                if (sh && typeof sh.updateNow === 'function') { sh.updateNow(); return; }
                // 旧壳没有 updateNow：转系统浏览器下载安装包（装上一次新壳后就有一键更新了）
                location.href = './android/vocab-flash.apk';
              } catch (e) { toast('更新失败，请手动下载 APK 安装'); }
            });
          }
          const seenApk = sessionStorage.getItem('sgwd_apk_toast');
          if (!seenApk) {
            sessionStorage.setItem('sgwd_apk_toast', '1');
            toast('📲 App 有新版本，可到设置页一键更新');
          }
        }
      } catch (e) { /* 壳接口不可用则跳过 */ }
    }
  } catch (e) { /* 版本信息可选，失败不影响使用 */ }

  applySettings();
  renderUnits();
  renderContinue();
  renderWrongList();
  nav('units');
  srsMigrateLearned(); // 老数据：已学过的词一次性纳入复习排期（明天首轮，不爆发）
  Reminder.init();
  Sync.init();
  migrateTodo();
  bindTodo();
  renderTodoRemBar();
  Reading.bind();
  Reading.renderHome();
  Listening.bind();
  Listening.renderHome();

  // 从通知/桌面快捷方式点进来：?view=todo|favorites|wrong|units|settings 直达对应页
  try {
    const qv = new URLSearchParams(location.search).get('view');
    if (qv && ['todo', 'favorites', 'wrong', 'units', 'settings'].includes(qv)) nav(qv);
  } catch (e) { /* ignore */ }

  // 阶段二：全量词库后台加载（含离线时的 SW 缓存回退）
  const ok = await ensureData();
  if (!ok && !META) {
    $('#unit-list').innerHTML = '<div class="empty-tip">词库加载失败，请联网后重开一次</div>';
  }
}
/* 位置兜底：定期快照（部分环境 scroll 事件不可靠），每 3 秒仅在停留学习页时保存 */
setInterval(() => {
  if (currentView === 'study' && studyUnitId != null) saveStudyPos();
}, 3000);

boot();
