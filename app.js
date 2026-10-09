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
  Object.keys(r.done || {}).forEach((k) => { const ts = r.done[k] && r.done[k].ts; if (ts) days.add(bjDateOf(ts)); });
  const l = (state && state.listen) || {};
  Object.keys(l.done || {}).forEach((k) => { const ts = l.done[k] && l.done[k].ts; if (ts) days.add(bjDateOf(ts)); });
  // 背词（新学+复习）也算打卡：dayLog 的键即北京日期串
  const g = (state && state.dayLog) || {};
  Object.keys(g).forEach((d) => { const e = g[d] || {}; if ((e.n || 0) + (e.r || 0) > 0) days.add(d); });
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

/** 存档 → state 的完整字段重建。loadState 与「导入备份」共用。
 *  曾缺 srs/dayLog/srsInitAt/dailyCfg/dailyTasks 五个键：启动后惰性函数会把它们
 *  重建为空，saveState 再覆盖存档 → 每次重启 SRS 复习进度与热力图历史全部清零。 */
function normalizeProgress(s) {
  s = s || {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return {
    learned: obj(s.learned),
    wrong: obj(s.wrong),
    favorites: obj(s.favorites),
    stats: obj(s.stats),
    settings: Object.assign({}, DEFAULT_STATE.settings, s.settings || {}),
    scrolls: obj(s.scrolls),
    lastUnit: s.lastUnit || null,
    reminder: Object.assign({}, DEFAULT_STATE.reminder, s.reminder || {}),
    todo: Array.isArray(s.todo) ? s.todo : [],
    reading: normalizeReading(s.reading),
    listen: normalizeListen(s.listen),
    favStars: obj(s.favStars),
    sync: Object.assign({ code: '', partner: '', on: false, lastSync: 0, tomb: {}, ntfyTopic: '', pushplusToken: '' }, s.sync || {}),
    srs: obj(s.srs),
    dayLog: obj(s.dayLog),
    srsInitAt: s.srsInitAt || 0,
    dailyCfg: obj(s.dailyCfg),
    dailyTasks: Array.isArray(s.dailyTasks) ? s.dailyTasks : [],
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return normalizeProgress(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return normalizeProgress(null);
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

/* 平台判断：iPhone/iPad（决定显示 iOS 专属文案） */
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent || ''); }

/* 轻震动反馈（安卓有效；iOS 网页应用不支持则静默跳过） */
function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { } }

function toast(msg, ms = 1800) {  const t = $('#toast');
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

/** 词库总词数（数据驱动：新词库追加后自动跟随） */
function totalWords() {
  try { return DATA.units.reduce((sum, u) => sum + u.words.length, 0); } catch (e) { return 2007; }
}
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

  async function request(action, payload, timeoutMs) {
    const ctrl = new AbortController();
    const limit = Number(timeoutMs) || 15000; // 默认弱网下 15 秒必给反馈；AI 等长任务可放宽
    const tid = setTimeout(() => ctrl.abort(), limit);
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
      if (e.name === 'AbortError') { const err = new Error('网络超时（' + Math.round(limit / 1000) + ' 秒无响应）'); err.code = 'TIMEOUT'; throw err; }
      throw e;
    }
    clearTimeout(tid);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) { const e = new Error((j && j.message) || ('HTTP ' + res.status)); e.code = j && j.error; throw e; }
    return j;
  }

  function tomb(key) { cfg().tomb[key] = Date.now(); }
  function untomb(key) { const t = cfg().tomb; if (t[key] !== undefined) t[key] = -Date.now(); }

  /* ---- SSE 流式聊天（问史 wsstream 同款方案：HTTP 函数 + getReader）----
     返回 {text, left, model, partial}；onDelta(piece, full) 逐字回调。
     握手失败（非 2xx JSON）抛 err.code 契约错误；流式中途 error 事件且已有输出 → partial=true。 */
  const STREAM_API = 'https://qinfweihe1-d5gxpjjli9f8f238b.service.tcloudbase.com/vfstream';
  async function streamChat(payload, onDelta, signal) {
    let res;
    try {
      res = await fetch(STREAM_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'ai.chat', code: cfg().code || undefined }, payload || {})),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') { const err = new Error('已停止'); err.code = 'ABORTED'; throw err; }
      const err = new Error('网络异常（流式通道不可达）'); err.code = 'TIMEOUT'; throw err;
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const e = new Error((j && j.message) || ('HTTP ' + res.status));
      e.code = j && j.error;
      throw e;
    }
    if (!res.body || !res.body.getReader) { const e = new Error('当前环境不支持流式'); e.code = 'NO_STREAM'; throw e; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', left = null, model = '', streamErr = null, aborted = false;
    while (true) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) {
        if (signal && signal.aborted) { aborted = true; break; }
        throw e;
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === 'delta') { text += ev.text || ''; if (onDelta) onDelta(ev.text || '', text); }
          else if (ev.type === 'end') { left = ev.left; model = ev.model || ''; }
          else if (ev.type === 'error') { streamErr = new Error(ev.message || '流式中断'); streamErr.code = ev.error; }
        } catch (e) { /* 忽略坏行 */ }
      }
    }
    buf += dec.decode(); // TextDecoder 无 end()：无参调用即 flush 尾部多字节（问史坑：别用 StringDecoder 的 API）
    if (aborted) { const e = new Error('已停止生成'); e.code = 'ABORTED'; e.partialText = text; throw e; }
    if (streamErr && !text) throw streamErr;
    return { text, left, model, partial: !!streamErr };
  }


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
      const failed = [];
      for (const d of DOMAINS) {
        const h = domainHash(d);
        if (!force && hs[d] === h) continue;
        try {
          await request('state.put', { domain: d, data: domainPayload(d) });
          setHash(d, h);
        } catch (e) {
          failed.push(d); // 单域失败（如超限）不阻断其它域同步
        }
      }
      cfg().lastSync = Date.now();
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
      if (failed.length) status('部分域同步失败：' + failed.join('、') + '（其它已同步）', 'err');
      else status('已同步 ✓ ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'ok');
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
      if (typeof renderToday === 'function') renderToday(); // 今日任务/热力图随同步数据刷新
      if (typeof renderHeat === 'function' && currentView === 'units') renderHeat();
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
      const win = (a, b) => a === b ? '' : (a > b ? ' [赢]' : '');
      const who = friendName() || 'TA';
      const rank = `今日：我 ${myToday} 词${win(myToday, s.todayCount || 0)} ⇄ ${who} ${s.todayCount || 0} 词${win(s.todayCount || 0, myToday)}`
        + ` · 连续：我 ${myStreak} 天${win(myStreak, s.streak || 0)} ⇄ ${who} ${s.streak || 0} 天${win(s.streak || 0, myStreak)}`
        + ` · 累计：我 ${myTotal} ⇄ ${who} ${s.learnedTotal || 0}`;
      // 通知能力判定：App 系统通知（壳）/ ntfy / 微信 / 网页推送，任一即可达
      const bits = [];
      if (s.hasShell) bits.push('App 系统通知 ✓');
      else if (s.hasNtfy) bits.push('已连 ntfy ✓');
      if (s.hasWechat) bits.push('已连微信 ✓');
      if (s.pushCount) bits.push('网页推送 ' + s.pushCount + ' 台设备');
      if (s.reminderEnabled) bits.push('已开每日提醒');
      bits.push('最后活跃 ' + agoText(s.lastActive || s.lastSeen));
        const canRecv = s.hasShell || s.hasNtfy || s.hasWechat || s.pushCount > 0;
        if (!canRecv) bits.unshift('还没有可用通知通道');
        el.innerHTML = `${who}的状态：<br>${rank}<br>${bits.join(' · ')}`;
        el.className = 'set-note' + (canRecv ? ' ' : ' err');
        // 缓存徽章数据供好友卡展示
        state.sync.partnerMeta = { streak: s.streak || 0, learnedTotal: s.learnedTotal || 0, todayCount: s.todayCount || 0, ts: Date.now() };
        saveState();
        renderFriends();
    } catch (e) {
      el.textContent = '对方状态：读取失败（' + String(e.message || e).slice(0, 40) + '）';
    }
  }

  // ---- 好友卡（备注名 + 状态；界面按列表设计，为将来多好友预留） ----
  const friendName = () => (state.sync && state.sync.partnerName) || '';
  const AVATARS = ['🌸', '⭐', '🔥', '🏆', '🐱', '🐶', '🐼', '🦊'];
  function renderFriends() {
    const box = $('#friend-list');
    if (!box) return;
    if (!cfg().partner) {
      box.innerHTML = '<div class="set-note">还没有好友——在下面「伙伴同步码」里填对方的码，点结对即可。</div>';
      return;
    }
    const nm = friendName();
    const av = (state.sync && state.sync.partnerAvatar) || '';
    const initial = av || (nm ? nm.slice(0, 1) : '友');
    const meta = (state.sync && state.sync.partnerMeta) || {};
    const badges = [];
    if (meta.streak) badges.push('🔥 连胜 ' + meta.streak + ' 天');
    if (meta.learnedTotal) badges.push('📚 累计 ' + meta.learnedTotal + ' 词');
    if (meta.todayCount) badges.push('今日 ' + meta.todayCount + ' 词');
    box.innerHTML = `
      <div class="friend-card">
        <button class="friend-avatar" id="friend-avatar-btn" title="点头像换一个">${esc(initial)}</button>
        <div class="friend-main">
          <div class="friend-name">${nm ? esc(nm) : '未命名好友'} <button class="mini-btn" id="friend-rename">${nm ? '改名' : '起个名字'}</button></div>
          <div class="friend-code">已结对 · ${esc(cfg().partner)}</div>
          ${badges.length ? `<div class="friend-badges">${badges.join(' · ')}</div>` : ''}
        </div>
      </div>
      <div id="avatar-pick" class="avatar-pick hidden">
        ${AVATARS.map((a) => `<button class="avatar-opt" data-av="${a}">${a}</button>`).join('')}
        <button class="avatar-opt" data-av="">首字</button>
      </div>`;
    const rb = $('#friend-rename');
    if (rb) rb.addEventListener('click', () => {
      const v = prompt('给 TA 起个名字（12 字以内，互戳提示和通知里都用它）：', nm || '');
      if (v === null) return;
      state.sync.partnerName = String(v).trim().slice(0, 12);
      saveState();
      if (typeof Reminder !== 'undefined') Reminder.sync(true); // 备注名随提醒设置上传（通知文案用）
      renderFriends();
      refreshPartnerStatus();
      toast(state.sync.partnerName ? '备注已保存：' + state.sync.partnerName : '已清除备注');
    });
    const ab = $('#friend-avatar-btn');
    if (ab) ab.addEventListener('click', () => $('#avatar-pick').classList.toggle('hidden'));
    $$('#avatar-pick [data-av]').forEach((b) => b.addEventListener('click', () => {
      state.sync.partnerAvatar = b.dataset.av || '';
      saveState();
      renderFriends();
      toast(b.dataset.av ? '头像已换成 ' + b.dataset.av : '头像已恢复首字');
    }));
  }

  let renderAcctRef = null; // init 内 renderAcct 的顶层引用（renderUI 里刷新账号区用）
  function renderUI() {
    const c = cfg();
    tellShell();
    const on = $('#sync-on'); if (on) on.checked = !!c.on;
    if (typeof renderFriends === 'function') renderFriends();
    if (typeof renderAcctRef === 'function' && renderAcctRef) renderAcctRef();
    if (c.on && c.code) {
      status((c.partner ? '已开启 · 好友 ' + ((state.sync && state.sync.partnerName) || c.partner) : '已开启') + (c.lastSync ? ' · 上次同步 ' + new Date(c.lastSync).toLocaleTimeString('zh-CN', { hour12: false }) : ''), 'ok');
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
    $('#sync-pair').addEventListener('click', async () => {
      const uname = ($('#sync-partner').value || '').trim().toLowerCase();
      if (!cfg().code) { status('先在「我的账号」注册或登录', 'err'); return; }
      if (!/^[a-z0-9_]{3,20}$/.test(uname)) { status('输入对方的用户名（3~20 位字母数字）', 'err'); return; }
      status('正在加好友…');
      try {
        const r2 = await request('pair.byuser', { user: uname });
        cfg().partner = r2.partner; saveState(); renderUI();
        if (!state.sync.partnerName && r2.partnerName) state.sync.partnerName = r2.partnerName; // 自动用对方昵称
        saveState();
        renderFriends();
        $('#sync-partner').value = '';
        status('已和「' + (friendName() || r2.partnerName || uname) + '」成为好友 ✓ 现在可以互戳了', 'ok');
        refreshPartnerStatus();
      } catch (e) { status('加好友失败：' + String(e.message || e).slice(0, 60), 'err'); }
    });
    $('#sync-push').addEventListener('click', async () => {
      if (!cfg().on) { status('先开启云同步', 'err'); return; }
      status('正在同步…');
      try { await pullMerge(); await pushAll(true); } catch (e) { /* 状态已显示 */ }
    });
    // ---- 互动：戳一下 / 附言 / 送礼物（共用发送） ----
    async function sendPoke(text, isGift) {
      if (!cfg().partner) { status('先在「我的好友」里结对', 'err'); return false; }
      const who = friendName() || 'TA';
      try {
        const r = await request('poke', { to: cfg().partner, text: String(text || '该背单词啦！').slice(0, 80) });
        const d = (r && r.delivered) || {};
        const pushSent = (d.push && d.push.sent) || 0;
        const ntfyOk = !!(d.ntfy && d.ntfy.published);
        const wechatOk = !!(d.wechat && d.wechat.published);
        const what = isGift ? '已送出 ' : '已戳 ';
        if (pushSent > 0 && (ntfyOk || wechatOk)) toast(what + who + ' ✓ 多个通道都发了');
        else if (pushSent > 0) toast(what + who + ' ✓ 网页推送已发出');
        else if (ntfyOk) toast(what + who + ' ✓ 已发到 TA 的 ntfy');
        else if (wechatOk) toast(what + who + ' ✓ 已发到 TA 的微信');
        else if (r && r.toHasShell) toast(what + who + ' ✓ 已放进消息盒——TA 的 App 取件后会提醒（最长 15 分钟）');
        else toast(what + who + '：已放进消息盒（TA 暂时没有可用通知通道，打开应用能看到）');
        refreshPartnerStatus();
        return true;
      } catch (e) {
        toast(String(e.message || e).slice(0, 60));
        return false;
      }
    }
    $('#sync-poke').addEventListener('click', () => sendPoke('该背单词啦！'));
    // 礼物四连
    $$('[data-gift]').forEach((b) => b.addEventListener('click', () => sendPoke(b.dataset.gift, true)));
    // 附言模板
    $$('[data-poke]').forEach((b) => b.addEventListener('click', () => sendPoke(b.dataset.poke)));
    // 自定义附言
    $('#poke-send').addEventListener('click', async () => {
      const v = ($('#poke-text').value || '').trim();
      if (!v) { toast('先写一句或点上面的快捷模板'); return; }
      const ok = await sendPoke(v);
      if (ok) $('#poke-text').value = '';
    });

    // ---- 账号密码（同步码的友好登录入口） ----
    const acctGet = () => { try { return JSON.parse(localStorage.getItem('sgwd_account') || 'null'); } catch (e) { return null; } };
    const acctSet = (v) => { if (v) localStorage.setItem('sgwd_account', JSON.stringify(v)); else localStorage.removeItem('sgwd_account'); };
    const ACCT_AVATARS = ['🌸', '⭐', '🔥', '🏆', '🐱', '🐶', '🐼', '🦊', '🐰', '🌟', '🍀', '🎯'];
    let acctAvatar = (state.sync && state.sync.profileAvatar) || '🌸';
    function renderAcct() {
      const logged = $('#acct-logged'), form = $('#acct-form'), out = $('#acct-out-wrap');
      const migrate = $('#acct-migrate');
      if (!logged || !form || !out) return;
      const a = acctGet();
      if (a && a.user) {
        const nm = (state.sync && state.sync.profileName) || a.user;
        const av = (state.sync && state.sync.profileAvatar) || '🌸';
        logged.innerHTML = '已登录：<b>' + esc(av + ' ' + nm) + '</b>（' + esc(a.user) + '）✓ 换设备登录即可取回进度';
        logged.classList.remove('hidden');
        form.classList.add('hidden');
        out.classList.remove('hidden');
        if (migrate) migrate.classList.add('hidden');
      } else {
        logged.classList.add('hidden');
        form.classList.remove('hidden');
        out.classList.add('hidden');
        // 迁移横幅：有旧同步码但还没账号
        if (migrate) {
          if (cfg().code && cfg().on) {
            migrate.textContent = '💡 你还在用旧的同步码方式。点下面「注册」设置用户名和密码后，换设备直接用账号登录（进度自动绑定，不影响现有数据）。';
            migrate.classList.remove('hidden');
          } else {
            migrate.classList.add('hidden');
          }
        }
      }
      // 头像按钮与选择条
      const ab = $('#acct-avatar-btn');
      if (ab) {
        ab.textContent = acctAvatar;
        if (!ab._bound) {
          ab._bound = true;
          ab.addEventListener('click', () => {
            const pick = $('#acct-avatar-pick');
            if (!pick) return;
            if (pick.innerHTML === '') {
              pick.innerHTML = ACCT_AVATARS.map((x) => '<button class="avatar-opt" data-av2="' + x + '">' + x + '</button>').join('');
              pick.querySelectorAll('[data-av2]').forEach((b) => b.addEventListener('click', () => {
                acctAvatar = b.dataset.av2;
                ab.textContent = acctAvatar;
                pick.classList.add('hidden');
              }));
            }
            pick.classList.toggle('hidden');
          });
        }
      }
    }
    renderAcctRef = renderAcct;

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
        const pname = ($('#acct-name').value || '').trim();
        const r = await request('account.register', { user, pass, code: cfg().code, profileName: pname, profileAvatar: acctAvatar });
        acctSet({ user: r.user, ts: Date.now() });
        if (r.profileName) state.sync.profileName = r.profileName;
        if (r.profileAvatar) state.sync.profileAvatar = r.profileAvatar;
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
        if (r.profileName) state.sync.profileName = r.profileName;
        if (r.profileAvatar) state.sync.profileAvatar = r.profileAvatar;
        saveState();
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

    const refreshBtn = $('#partner-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshPartnerStatus);

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

  return { init, markDirty, tomb, untomb, request, streamChat, ensureOn, ensureCode, enable, disable, pushAll, pullMerge, afterReset, isShell, renderFriends, refreshPartnerStatus, renderUI };
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

/** 提醒已统一到设置页管理（待办页不再有状态条）；保留空实现防旧调用点报错 */
function renderTodoRemBar() { }

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
        <button class="t-del" data-del="${esc(it.id)}" aria-label="删除"><i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z%27/%3E%3C/svg%3E&quot;)"></i></button>
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
const TAB_VIEWS = ['units', 'favorites', 'settings', 'ai'];

let pendingFavSeg = null, pendingHomePanel = null; // 路由别名（wrong→收藏错词段 / todo→首页待办面板）
function nav(view) {
  if (window.speechSynthesis) speechSynthesis.cancel(); // 切页即停朗读
  if (view === 'wrong') { pendingFavSeg = 'wrong'; view = 'favorites'; }
  if (view === 'todo') { pendingHomePanel = 'todo'; view = 'units'; }
  if (view === 'daily') { pendingHomePanel = 'daily'; view = 'units'; }
  if (currentView === 'study' && view !== 'study') {
    saveStudyPos();                    // 离开学习页前保存精确位置（词级）
    if (view === 'units') inStudy = false; // 只有主动回列表才算退出学习态
  }
  if (currentView === 'favorites' && view !== 'favorites') saveListPos('#fav-list', 'fav');
  if (currentView === 'wrong' && view !== 'wrong') saveListPos('#wrong-list', 'wrong');
  currentView = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (!el) return; // 视图不存在（旧别名已在上面映射）
  if (el) el.classList.remove('hidden');
  $$('#tabbar .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === view || (view === 'study' && b.dataset.nav === 'units'));
  });
  if (TAB_VIEWS.includes(view)) window.scrollTo({ top: 0 });
  if (view === 'units' && typeof renderContinue === 'function') renderContinue();
  if (view === 'units' && typeof renderToday === 'function') { renderToday(); renderHeat(); }
  if (view === 'units' && typeof showHomePanel === 'function') {
    showHomePanel(null); // 回首页回到主页列表
    if (pendingHomePanel) {
      showHomePanel(pendingHomePanel);
      if (pendingHomePanel === 'todo') renderTodo(); // 待办面板打开时刷新列表
      if (pendingHomePanel === 'daily') Daily.open(); // 每日精进：打开即拉取
      pendingHomePanel = null;
    }
  }
  if (view === 'settings' && typeof showSetPanel === 'function') showSetPanel(null); // 进设置页回到主页列表
  if (view === 'units') { Reading.renderHome(); Listening.renderHome(); Daily.renderHome(); }
  if (view === 'favorites' && typeof renderFavorites === 'function') {
    Reading.renderWrongVocab(); Listening.renderWrongVocab();
    const target = pendingFavSeg || favSeg; pendingFavSeg = null;
    setFavSeg(target);
  }
  if (view === 'reading') Reading.renderPage();
  if (view === 'ai') { AI.renderMsgs(); AI.applyBackBtn(); }
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
    if (isWrong(studyUnitId, w.w)) card.classList.add('is-wrong');
    card.dataset.idx = idx;

    const defsHtml = w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>');
    const rowsHtml = wordDetailRows(w);

    card.innerHTML = `
      <div class="wc-head">
        <div class="wc-main">
          <div class="wc-word-row">
            <span class="wc-word">${w.w} <span class="wc-wrong-badge">错词</span></span>
            ${w.freq ? `<span class="wc-freq">${w.freq}</span>` : ''}
            <button class="fav-btn${isFav(studyUnitId, w.w) ? ' on' : ''}" data-fav="${idx}" aria-label="收藏">${isFav(studyUnitId, w.w) ? '★' : '☆'}</button>
          </div>
          ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
          <div class="wc-cn${hideCn ? ' hide-cn' : ''}">${defsHtml}</div>
        </div>
        <div class="wc-actions">
          <button class="speak-btn" data-speak="${idx}"><i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M11 5L6 9H2v6h4l5 4V5z%27/%3E%3Cpath d=%27M15.5 8.5a5 5 0 0 1 0 7M19 5a9.5 9.5 0 0 1 0 14%27/%3E%3C/svg%3E&quot;)"></i></button>
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
      card.classList.toggle('is-wrong', isWrong(studyUnitId, w.w)); // 红标即时跟随
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
      toast(on ? '已收藏，之后可在「收藏」里复习' : '已取消收藏');
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
    u.words.forEach((w) => srsRemove(studyUnitId, w.w)); // 取消全标同步退出复习排期
    toast('已取消全部标记');
  } else {
    const m = {};
    let newly = 0;
    u.words.forEach((w) => {
      if (!state.learned[String(studyUnitId)] || !state.learned[String(studyUnitId)][wordKey(w.w)]) newly++;
      m[wordKey(w.w)] = true;
      srsInit(studyUnitId, w.w); // 全标与逐个勾选同样进 SRS
    });
    state.learned[String(studyUnitId)] = m;
    if (newly > 0) logLearn('n', newly); // 今日任务的新词计数与逐个勾选一致
    toast('已全部标记为已学');
  }
  saveState(); renderWordList(); renderUnits();
  if (typeof renderToday === 'function') renderToday();
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
function logLearn(kind, n) { // kind: 'n' 新词 / 'r' 复习；n 默认 1（批量标记时传数量）
  const g = todayLog();
  const d = bjDayStr();
  g[d] = g[d] || { n: 0, r: 0 };
  g[d][kind] = (g[d][kind] || 0) + (n || 1);
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
  if (you.length > right.length) { // 多拼的部分也显示（红），不再静默截断
    html += `<span class="no">${esc(you.slice(right.length))}</span>`;
  }
  return html;
}

function spellSubmit() {
  if (!test || !test.queue[test.pos]) return;
  const item = test.queue[test.pos];
  const target = String(item.word.w).toLowerCase();
  const you = String($('#spell-input').value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!you) { toast('先输入字母再提交'); return; }
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
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!$('#spell-submit').classList.contains('hidden')) spellSubmit(); }
});
$('#test-mode').addEventListener('click', () => {
  if (!test) return;
  test.mode = test.mode === 'spell' ? 'flash' : 'spell';
  showCard();
});

/* ---- 检验会话断点续做：judge 后与退出时存档，当天同 key 再进来从断点继续（已判定词不再出现） ---- */
const TEST_SESS_KEY = 'sgwd_test_sess';
function saveTestSess() {
  if (!test || !test.sessKey) return;
  try {
    localStorage.setItem(TEST_SESS_KEY, JSON.stringify({
      key: test.sessKey, title: test.origin, mode: test.mode, pos: test.pos,
      right: test.right, miss: test.miss || [], queue: test.queue,
      day: bjDayStr(), ts: Date.now(),
    }));
  } catch (e) { /* 存储满等异常不阻断检验 */ }
}
function loadTestSess(key) {
  try {
    const s = JSON.parse(localStorage.getItem(TEST_SESS_KEY) || 'null');
    if (!s || s.key !== key || s.day !== bjDayStr()) return null; // 跨天作废（SRS 到期已变化）
    if (!Array.isArray(s.queue) || !s.queue.length || s.pos >= s.queue.length) return null; // 已做完
    return s;
  } catch (e) { return null; }
}
function clearTestSess() { try { localStorage.removeItem(TEST_SESS_KEY); } catch (e) { } }

function startTest(queue, title, sessKey) {
  if (!queue.length) { toast('没有可检验的词'); return; }
  const key = sessKey || ('t:' + title);
  const prev = loadTestSess(key);
  if (prev) {
    // 断点续做：恢复队列/进度/判定结果，已判定的词不再出现
    test = { queue: prev.queue, pos: prev.pos, phase: 'read', origin: prev.title, right: prev.right || 0, miss: prev.miss || [], mode: prev.mode || 'flash', sessKey: key };
    toast('已回到上次进度（' + (prev.pos + 1) + '/' + prev.queue.length + '）');
  } else {
    test = { queue, pos: 0, phase: 'read', origin: title, right: 0, miss: [], mode: (test && test.mode) || 'flash', sessKey: key };
    saveTestSess();
  }
  $('#test-title').textContent = test.origin;
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
  // 语境挑战区复位（换词后上一题的选项与解析不能残留）
  $('#srs-ctx-box').classList.add('hidden');
  $('#srs-ctx-box').innerHTML = '';
  $('#btn-srs-ctx').classList.remove('hidden');
  $('#btn-srs-ctx').textContent = '语境挑战';
  $('#test-stage').classList.remove('hidden');
  $('#test-done').classList.add('hidden');
  window.scrollTo({ top: 0 });
}

// 语境挑战：AI 例句挖空选义（不影响 SRS 评分，答错只给解析）
function renderSrsCtx(box, d) {
  if (!d || !d.sent || !Array.isArray(d.opts) || d.opts.length < 2) {
    box.innerHTML = '<div class="ai-msg bot">出题格式异常，稍后再试</div>';
    return;
  }
  box.innerHTML = `<div class="sc-sent">${esc(String(d.sent)).replace(/_{2,}/g, '<b class="sc-blank">＿＿＿</b>')}</div>
    <div class="sc-opts">${d.opts.map((o, j) => `<button class="sc-opt" data-j="${j}">${'ABCD'[j]}. ${esc(String(o))}</button>`).join('')}</div>
    <div class="sc-note hidden"></div>`;
  const ans = Number(d.ans);
  box.querySelectorAll('.sc-opt').forEach((b) => b.addEventListener('click', () => {
    const item = box.querySelector('.sc-opts');
    if (item.dataset.done) return;
    item.dataset.done = '1';
    const j = Number(b.dataset.j);
    const hit = j === ans;
    box.querySelectorAll('.sc-opt').forEach((ob, oj) => {
      ob.disabled = true;
      if (oj === ans) ob.classList.add('right');
      else if (oj === j) ob.classList.add('wrong');
    });
    const note = box.querySelector('.sc-note');
    note.classList.remove('hidden');
    note.textContent = (hit ? '✓ 答对了 · ' : '✗ 答错了 · ') + (d.note || '');
  }));
}

$('#btn-srs-ctx').addEventListener('click', async () => {
  if (!test || !test.queue[test.pos]) return;
  const w = test.queue[test.pos].word;
  const box = $('#srs-ctx-box'), btn = $('#btn-srs-ctx');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); btn.textContent = '语境挑战'; return; }
  btn.textContent = '收起挑战';
  const d0 = (w.defs && w.defs[0]) || {};
  const done = await StudyAI.ask('srsCtx', { w: w.w, cn: d0.cn || '', pos: d0.pos || '' }, box, '出题中…', renderSrsCtx);
  if (!done) { box.classList.add('hidden'); btn.textContent = '语境挑战'; } // 失败收起，可再点重试
});

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
  if (!test || !test.queue[test.pos]) return; // 防重入：快速双击判定按钮时不重复计分
  const item = test.queue[test.pos];
  const remembered = mode === 'got';
  state.stats.tested += 1;
  if (remembered) state.stats.correct += 1;
  buzz(remembered ? 15 : [30, 50, 30]); // 轻震动反馈（iOS 网页应用不支持则自动跳过）

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
  saveTestSess(); // 判定粒度存档：退出再进从下一词继续
  showCard();
  if (typeof renderToday === 'function') renderToday();
  if (currentView === 'units') renderHeat();
}

function finishTest() {
  clearTestSess(); // 做完整组才清档
  $('#test-stage').classList.add('hidden');
  $('#test-done').classList.remove('hidden');
  const n = test.queue.length;
  const r = test.right;
  $('#done-body').innerHTML = `本组共 ${n} 词<br><b class="ok">✓</b> 记住 ${r} · <b class="no">✗</b> 没记住 ${n - r}<br>正确率 ${n ? Math.round((r / n) * 100) : 0}%`
    + (test.miss.length ? `<br><span style="font-size:12.5px;color:var(--ink-2)">⏳ 3 秒后自动回炉 ${test.miss.length} 个错词（点「返回」可取消）</span>
      <br><button class="ghost-btn" id="miss-ai-btn" style="margin-top:8px;padding:6px 14px">AI 帮我记错词</button>` : '');
  const missAi = $('#miss-ai-btn');
  if (missAi && test.miss.length) {
    missAi.addEventListener('click', () => {
      const w = test.miss.map(function (x) { return x.word && x.word.w; }).filter(Boolean).slice(0, 3).join('、');
      if (w) aiRememberWord(w);
    });
  }
  renderUnits();
  // 错词当场回炉：3 秒后自动再测（仍在检验页才触发；返回/切走即取消）
  if (test.miss.length) {
    const missSnapshot = test.miss.slice();
    setTimeout(() => {
      if (currentView !== 'test' || !test || $('#test-done').classList.contains('hidden')) return;
      startTest(missSnapshot, '错词回炉 · 再来一轮', 'retry');
    }, 3000);
  }
}

$('#btn-test-again').addEventListener('click', () => {
  if (!test || !test.miss.length) { toast('没有需要重测的词'); return; }
  startTest(test.miss.slice(), '重测没记住的', 'retry');
});

$('#btn-test-unit').addEventListener('click', () => {
  const u = unitById(studyUnitId);
  startTest(buildQueueByUnit(studyUnitId), `检验 ${u.name}`, 'unit:' + studyUnitId);
});

$('#btn-test-wrong').addEventListener('click', () => {
  startTest(buildQueueWrong(), '检验错词本', 'wrong');
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

/* ================= 收藏页分段（收藏夹 / 错词本） ================= */
let favSeg = 'fav';
function setFavSeg(seg) {
  favSeg = seg === 'wrong' ? 'wrong' : 'fav';
  const f = $('#fav-seg-fav'), w = $('#fav-seg-wrong');
  if (f) f.classList.toggle('hidden', favSeg !== 'fav');
  if (w) w.classList.toggle('hidden', favSeg !== 'wrong');
  $$('.fav-seg').forEach((b) => b.classList.toggle('active', b.dataset.seg === favSeg));
  const title = $('#fav-title');
  if (title) title.textContent = favSeg === 'wrong' ? '错词本' : '收藏夹';
  const tf = $('#btn-test-fav'), tw = $('#btn-test-wrong');
  if (tf) tf.classList.toggle('hidden', favSeg !== 'fav');
  if (tw) tw.classList.toggle('hidden', favSeg !== 'wrong');
  if (favSeg === 'wrong') { renderWrongList(); restoreListPos('#wrong-list', 'wrong'); }
  else { renderFavorites(); restoreListPos('#fav-list', 'fav'); }
}
const favSegBar = document.querySelector('.fav-seg-bar');
if (favSegBar) favSegBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-seg]');
  if (b) setFavSeg(b.dataset.seg);
});

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
      ? '<div class="empty-tip">这一档是空的<br>点上面的「全部」看看其它词<br>点上面的「全部」看看其它词</div>'
      : '<div class="empty-tip">收藏夹是空的<br>学习时点单词旁的「☆」把不熟的词收进来<br>学习时点单词旁的「☆」把不熟的词收进来，之后在这里集中复习</div>';
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
            <span class="mini-btn tag-y">${u.name}</span>
            ${w.freq ? `<span class="wc-freq">${w.freq}</span>` : ''}
          </div>
          ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
          <div class="wc-cn">${w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>')}</div>
        </div>
        <div class="wc-actions">
          <button class="speak-btn"><i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M11 5L6 9H2v6h4l5 4V5z%27/%3E%3Cpath d=%27M15.5 8.5a5 5 0 0 1 0 7M19 5a9.5 9.5 0 0 1 0 14%27/%3E%3C/svg%3E&quot;)"></i></button>
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
  startTest(q, title, 'fav');
});

/* ================= 错词本 ================= */
function renderWrongList() {
  const box = $('#wrong-list');
  box.innerHTML = '';
  // 顶部统计行：错词数 / 涉及单元 / 累计正确率
  let total = 0, units = 0;
  DATA.units.forEach((u) => {
    const m = state.wrong[String(u.id)] || {};
    const n = Array.isArray(m) ? m.length : Object.keys(m).length;
    if (n) { total += n; units++; }
  });
  if (total) {
    const pct = state.stats.tested ? Math.round(state.stats.correct / state.stats.tested * 100) : 0;
    const st = document.createElement('div');
    st.className = 'reading-stats';
    st.innerHTML = `<div class="rs-item"><b>${total}</b><span>错词</span></div>
      <div class="rs-item"><b>${units}</b><span>涉及单元</span></div>
      <div class="rs-item"><b>${pct ? pct + '%' : '—'}</b><span>累计正确率</span></div>`;
    box.appendChild(st);
  }
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
              <span class="mini-btn tag-r">${u.name}</span>
            </div>
            ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
            <div class="wc-cn">${w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>')}</div>
          </div>
          <div class="wc-actions">
            <button class="speak-btn"><i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M11 5L6 9H2v6h4l5 4V5z%27/%3E%3Cpath d=%27M15.5 8.5a5 5 0 0 1 0 7M19 5a9.5 9.5 0 0 1 0 14%27/%3E%3C/svg%3E&quot;)"></i></button>
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
  if (!count) box.innerHTML = '<div class="empty-tip">错词本还是空的<br>检验时「没记住」的词会出现在这里<br>检验时「没记住」的词会出现在这里</div>';
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
  meta.content = dark ? '#15161b' : '#ffffff';
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

/* ================= 设置页二级面板（主页条目 → 面板切换） ================= */
function showSetPanel(name) {
  const home = $('#settings-home');
  if (!home) return;
  $$('#view-settings .set-panel').forEach((p) => p.classList.add('hidden'));
  if (!name) { home.classList.remove('hidden'); return; }
  home.classList.add('hidden');
  const el = $('#setpanel-' + name);
  if (el) el.classList.remove('hidden');
  window.scrollTo({ top: 0 });
}
$('#settings-home').addEventListener('click', (e) => {
  const b = e.target.closest('[data-setpanel]');
  if (!b) return;
  showSetPanel(b.dataset.setpanel);
  // 打开好友面板时刷新好友卡与对方状态（接管/登录后数据才到位，此前不会渲染）
  if (b.dataset.setpanel === 'sync' && typeof Sync.renderUI === 'function') {
    try { Sync.renderUI(); } catch (e2) { /* 静默 */ }
  }
  if (b.dataset.setpanel === 'friend') {
    Sync.renderFriends();
    if (state.sync && state.sync.partner) {
      try { Sync.refreshPartnerStatus(); } catch (e2) { /* 静默 */ }
    }
  }
});
$$('.set-panel [data-setback]').forEach((b) => b.addEventListener('click', () => showSetPanel(null)));

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
      state = normalizeProgress(s); // 与 loadState 同一套字段重建（含 srs/dayLog/dailyCfg/dailyTasks，导入不丢复习进度）
      if (DATA.units.length) migrateProgress();
      saveState(); applySettings(); renderUnits(); renderWrongList(); renderFavorites();
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

/* ================= AI 学习讲解（ai.study：服务端 prompt + 云端共享缓存） =================
   阅读逐题讲解 / 全文精讲 / 句级讲解 / 错题模式分析共用：
   结果按内容哈希在云端缓存共享，同一篇只有第一次真实调用（命中不计每日次数）。 */
const StudyAI = (() => {
  function errText(e) {
    const m = String((e && e.message) || e);
    if (e && e.code === 'LIMIT') return '今天的 AI 次数用完了（每天 100 次，讲解有云端缓存不受影响）';
    if (e && (e.code === 'NO_KEY' || /未配置/.test(m))) return 'AI 还没配置好（找青峰放 Key）';
    if (e && (e.code === 'TIMEOUT' || /超时/.test(m))) return '生成超时了，点一下再试';
    return '生成失败：' + m.slice(0, 80);
  }
  /** 请求并渲染到 boxEl；返回 false=失败。同一 box 未完成时不重复请求。
      renderData：结构化出题类（r.data）的自定义渲染回调 renderData(boxEl, data)，负责 innerHTML 与绑定 */
  async function ask(kind, payload, boxEl, waitText, renderData) {
    if (!boxEl) return false;
    if (boxEl.dataset.busy === '1') return false;
    boxEl.dataset.busy = '1';
    boxEl.classList.remove('hidden');
    boxEl.innerHTML = `<div class="ai-msg bot ai-loading">${waitText || 'AI 讲解生成中…'}</div>`;
    try {
      if (typeof Sync === 'undefined' || !Sync.request) throw new Error('请先在设置 → 云同步 注册账号');
      let r;
      try {
        r = await Sync.request('ai.study', Object.assign({ kind }, payload), 90000);
      } catch (e1) {
        // 偶发空回复/上游抖动自动重试一次；限额、密钥类不浪费重试
        const RETRY = ['AI_EMPTY', 'TIMEOUT', 'AI_UPSTREAM'];
        if (RETRY.indexOf(e1 && e1.code) < 0) throw e1;
        await new Promise((r2) => setTimeout(r2, 800));
        r = await Sync.request('ai.study', Object.assign({ kind }, payload), 90000);
      }
      if (r && r.left != null && typeof AI !== 'undefined' && AI.showLeft) AI.showLeft(r.left);
      if (renderData && r && r.data !== undefined) { renderData(boxEl, r.data); return true; }
      boxEl.innerHTML = `<div class="ai-msg bot">${AI.mdLite(r && r.text)}</div>`;
      return true;
    } catch (e) {
      boxEl.innerHTML = `<div class="ai-msg bot">${esc(errText(e))}</div>`;
      return false;
    } finally {
      boxEl.dataset.busy = '0';
    }
  }
  return { ask, errText };
})();

/** AI 小练渲染与判分：data = [{q, opts[4], ans, note}]，答完显示总成绩 */
function renderRdQuiz(box, data) {
  if (!Array.isArray(data) || !data.length) { box.innerHTML = '<div class="ai-msg bot">出题格式异常，稍后再试</div>'; return; }
  let answered = 0, rightN = 0;
  box.innerHTML = '<div class="set-note" style="margin:2px 0 8px">AI 小练 · 点选项即时判分</div>'
    + data.map((t, i) => `
      <div class="rdq-item" data-i="${i}">
        <div class="rdq-q">${i + 1}. ${esc(String(t.q || ''))}</div>
        <div class="rdq-opts">${(t.opts || []).map((o, j) => `<button class="rdq-opt" data-j="${j}">${'ABCD'[j]}. ${esc(String(o))}</button>`).join('')}</div>
        <div class="rdq-note hidden"></div>
      </div>`).join('')
    + '<div class="rdq-score"></div>';
  box.querySelectorAll('.rdq-item').forEach((item) => {
    const t = data[Number(item.dataset.i)];
    item.querySelectorAll('.rdq-opt').forEach((b) => b.addEventListener('click', () => {
      if (item.dataset.done) return;
      item.dataset.done = '1';
      const j = Number(b.dataset.j);
      const hit = j === Number(t.ans);
      if (hit) rightN++;
      answered++;
      item.querySelectorAll('.rdq-opt').forEach((ob, oj) => {
        ob.disabled = true;
        if (oj === Number(t.ans)) ob.classList.add('right');
        else if (oj === j) ob.classList.add('wrong');
      });
      const note = item.querySelector('.rdq-note');
      note.classList.remove('hidden');
      note.textContent = (hit ? '✓ ' : '✗ ') + (t.note || '');
      if (answered === data.length) box.querySelector('.rdq-score').textContent = `小练成绩：${rightN}/${data.length}`;
    }));
  });
}

/* ================= 每日精进（毛选 & AI 方法论）=================
   数据流：每天早上由电脑上的定时任务生成讲解+题目 → 云端 → 这里读；
   用户作答 → 云端；次日早上点评写回云端 → 这里显示。
   摘要（light=1）只拉每条的状态，供首页卡片；全量在打开面板时拉。 */
const Daily = (() => {
  let DATA = null;    // 全量 {today, days, pending}
  let SUM = null;     // 摘要（首页卡片用）
  let LOADING = false;
  let SUM_AT = 0;
  const OPEN = {};    // 展开态：'day:<date>' / 'it:<date>:<src>'
  const EDIT = {};    // 'date:src' -> true（正在改答案）

  const SRC_NAME = { mao: '毛选', ai: '方法论' };
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function dayLabel(date) {
    const t = Date.parse(String(date) + 'T00:00:00+08:00');
    if (isNaN(t)) return String(date || '');
    const d = new Date(t + 8 * 3600e3);
    return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + WD[d.getUTCDay()];
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts) + 8 * 3600e3);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return (d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  /** 摘要：只拉状态不拉正文（首页卡片用，避免每次打开都下全量） */
  async function loadSummary(force) {
    if (!force && SUM && Date.now() - SUM_AT < 5 * 60 * 1000) { renderHome(); return; }
    try {
      const r = await Sync.request('daily.get', { light: 1 }, 15000);
      SUM = r; SUM_AT = Date.now();
      renderHome();
    } catch (e) { /* 静默：首页卡片保持"点开看看" */ }
  }

  /** 全量：面板用 */
  async function loadFull(force) {
    if (LOADING) return;
    const box = $('#daily-body');
    if (DATA && !force) { renderPanel(); return; }
    LOADING = true;
    if (box && !DATA) box.innerHTML = '<div class="daily-empty">加载中…</div>';
    try {
      const r = await Sync.request('daily.get', {}, 25000);
      DATA = { today: r.today || '', days: r.days || [], pending: r.pending || [] };
      renderPanel(); renderHome();
    } catch (e) {
      const m = e.code === 'BAD_CODE'
        ? '先在「设置 → 云同步」开启同步，作答才能存到云端'
        : ('加载失败：' + esc(e.message || '网络错误') + '<br><span class="daily-hint">点右上角「刷新」重试</span>');
      if (box) box.innerHTML = '<div class="daily-empty">' + m + '</div>';
    } finally { LOADING = false; }
  }

  const src = () => DATA || SUM;

  function renderHome() {
    const sub = $('#daily-card-sub'), badge = $('#daily-card-badge');
    if (!sub) return;
    const s = src();
    if (!s) { sub.textContent = '毛选 + AI 方法论 · 点开看看'; if (badge) badge.classList.add('hidden'); return; }
    const t = (s.days || []).find((d) => d.date === s.today);
    const pd = (s.pending || []).length;
    if (!t) {
      sub.textContent = '今天的内容还没到（每天约 8 点更新）' + (pd ? ' · 待补 ' + pd + ' 题' : '');
      if (badge) badge.classList.add('hidden');
      return;
    }
    const n = (t.items || []).length;
    const left = (t.items || []).filter((it) => !it.answer).length;
    const reviewed = (t.items || []).filter((it) => it.review).length;
    sub.textContent = (left ? '今日 ' + n + ' 题 · 待答 ' + left : '今日 ' + n + ' 题已答完 ✓' + (reviewed ? ' · 点评已到' : '')) + (pd ? ' · 待补 ' + pd : '');
    if (badge) {
      badge.textContent = left ? String(left) : '✓';
      badge.classList.remove('hidden');
      badge.classList.toggle('done', !left);
    }
  }

  /** 正文首行若与标题重复（只差加粗记号），剥掉避免双标题 */
  function stripDupTitle(body, title) {
    const s = String(body || '');
    const t = String(title || '').replace(/\*\*/g, '').trim();
    const nl = s.indexOf('\n');
    const first = (nl >= 0 ? s.slice(0, nl) : s).replace(/\*\*/g, '').trim();
    if (!t || !first) return s;
    if (first === t) return nl >= 0 ? s.slice(nl + 1) : '';
    return s;
  }

  function itemHtml(d, it) {
    const key = d.date + ':' + it.source;
    const openKey = 'it:' + key;
    const isToday = d.date === DATA.today;
    const bodyOpen = OPEN[openKey] !== undefined ? OPEN[openKey] : isToday;
    const editing = !!EDIT[key];
    let h = '<div class="daily-item">';
    h += '<div class="daily-item-head" data-daily-act="fold" data-key="' + openKey + '">'
       + '<span class="daily-tag ' + it.source + '">' + (SRC_NAME[it.source] || it.source) + '</span>'
       + '<span class="daily-item-title">' + esc(it.title || '') + '</span>'
       + '<span class="daily-arw' + (bodyOpen ? ' open' : '') + '">›</span></div>';
    h += '<div class="daily-item-body daily-md' + (bodyOpen ? '' : ' hidden') + '">' + AI.mdLite(stripDupTitle(it.body, it.title)) + '</div>';
    h += '<div class="daily-q"><span class="daily-qlabel">作答</span>' + esc(it.question || '') + '</div>';
    if (it.answer && !editing) {
      h += '<div class="daily-ans"><i class="daily-ans-label">我的作答 · ' + fmtTime(it.answer.at) + '</i>' + esc(it.answer.text) + '</div>';
      h += '<button class="ghost-btn mini-inline" data-daily-act="edit" data-key="' + key + '">修改</button>';
    } else {
      h += '<textarea class="daily-ta" data-daily-ta="' + key + '" rows="3" placeholder="写几句，不用长…">' + (it.answer ? esc(it.answer.text) : '') + '</textarea>';
      h += '<button class="primary-btn daily-submit" data-daily-act="submit" data-date="' + d.date + '">提交作答</button>';
    }
    if (it.review) {
      h += '<div class="daily-review daily-md"><i class="daily-review-label">' + (SRC_NAME[it.source] || '') + '点评 · ' + fmtTime(it.review.at) + '</i>' + AI.mdLite(it.review.text) + '</div>';
    }
    h += '</div>';
    return h;
  }

  function dayHtml(d) {
    const isToday = d.date === DATA.today;
    const key = 'day:' + d.date;
    const open = OPEN[key] !== undefined ? OPEN[key] : isToday;
    const items = d.items || [];
    const a = items.filter((it) => it.answer).length;
    const r = items.filter((it) => it.review).length;
    const stat = !items.length ? '' : (a === 0 ? '待答 ' + items.length : (a < items.length ? '已答 ' + a + '/' + items.length : '已答完' + (r ? ' · 已评' : '')));
    let h = '<div class="daily-day' + (isToday ? ' is-today' : '') + '">';
    h += '<button class="daily-day-head" data-daily-act="day" data-key="' + key + '">'
       + '<span class="daily-day-title">' + (isToday ? '今天 · ' : '') + dayLabel(d.date) + '</span>'
       + '<span class="daily-day-stat' + (items.length && a === items.length ? ' ok' : '') + '">' + stat + '</span>'
       + '<span class="daily-arw' + (open ? ' open' : '') + '">›</span></button>';
    h += '<div class="daily-day-body' + (open ? '' : ' hidden') + '">' + items.map((it) => itemHtml(d, it)).join('') + '</div>';
    return h + '</div>';
  }

  function renderPanel() {
    const box = $('#daily-body');
    if (!box || !DATA) return;
    const days = DATA.days || [];
    if (!days.length) {
      box.innerHTML = '<div class="daily-empty">云端还没有内容。<br><span class="daily-hint">每天早上约 8 点，毛选一条与 AI 方法论一讲会自动送到这里。</span></div>';
      return;
    }
    let h = '';
    const pd = DATA.pending || [];
    if (pd.length) {
      h += '<div class="daily-pending">待补 ' + pd.length + ' 题：'
         + pd.map((p) => dayLabel(p.date) + ' ' + (SRC_NAME[p.source] || '')).join('、')
         + ' —— 不催，有空补上；补答后会在下次点评里一起批。</div>';
    }
    for (const d of days) h += dayHtml(d);
    h += '<div class="set-note" style="margin-top:12px">作答后，第二天早上这里出现 AI 点评；点评与后续内容会按你的作答自适应调整。</div>';
    box.innerHTML = h;
  }

  async function submit(date) {
    const day = (DATA.days || []).find((d) => d.date === date);
    if (!day) return;
    const answers = {};
    for (const s of ['mao', 'ai']) {
      const ta = document.querySelector('[data-daily-ta="' + date + ':' + s + '"]');
      if (!ta) continue;
      const text = (ta.value || '').trim();
      if (text) answers[s] = { text, at: Date.now() };
    }
    if (!Object.keys(answers).length) { toast('先写两句再提交'); return; }
    const btn = document.querySelector('[data-daily-act="submit"][data-date="' + date + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    try {
      await Sync.request('daily.answer', { date, answers }, 20000);
      for (const k in EDIT) if (k.indexOf(date + ':') === 0) delete EDIT[k];
      toast('已提交 ✓ 明天早上来看点评');
      await loadFull(true);
      loadSummary(true);
    } catch (e) {
      toast('提交失败：' + (e.message || '网络错误'));
      if (btn) { btn.disabled = false; btn.textContent = '提交作答'; }
    }
  }

  function onClick(e) {
    const t = e.target.closest('[data-daily-act]');
    if (!t) return;
    const act = t.dataset.dailyAct, key = t.dataset.key || '';
    if (act === 'fold' || act === 'day') {
      const host = act === 'day' ? t.closest('.daily-day') : t.closest('.daily-item');
      const wrap = host && host.querySelector(act === 'day' ? '.daily-day-body' : '.daily-item-body');
      if (!wrap) return;
      const hid = wrap.classList.toggle('hidden');
      OPEN[key] = !hid;
      const arw = t.querySelector('.daily-arw');
      if (arw) arw.classList.toggle('open', !hid);
      return;
    }
    if (act === 'edit') { EDIT[key] = true; renderPanel(); return; }
    if (act === 'submit') { submit(t.dataset.date); return; }
  }

  function open() {
    if (typeof Sync !== 'undefined' && Sync.isShell && Sync.isShell()) return; // 壳内禁用
    loadFull(false);
    if (!DATA) loadFull(false);
  }

  function init() {
    // 安卓 App 壳内不启用每日精进（用户指定仅 iPhone 等非壳环境可见）
    if (typeof Sync !== 'undefined' && Sync.isShell && Sync.isShell()) {
      const card = document.getElementById('daily-card');
      if (card) card.classList.add('hidden');
      const panel = document.getElementById('homepanel-daily');
      if (panel) panel.remove();
      return;
    }
    const box = $('#daily-body');
    if (box && !box.dataset.dbound) { box.dataset.dbound = '1'; box.addEventListener('click', onClick); }
    const rf = $('#daily-refresh');
    if (rf && !rf.dataset.dbound) { rf.dataset.dbound = '1'; rf.addEventListener('click', () => { loadFull(true); loadSummary(true); }); }
    loadSummary(false);
  }

  return { init, open, renderHome, loadSummary, loadFull };
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
    list.innerHTML = (doneIds.length >= 3
      ? '<button class="ghost-btn" id="rd-pattern-btn" style="margin:12px 2px 4px;width:100%">AI 分析我的错题</button><div class="rd-ai-box hidden" id="rd-pattern-box"></div>'
      : '')
      + (doneIds.length
        ? '<div class="set-note" style="margin:10px 2px 6px">做过的篇目（点击重做）</div>' + doneIds.map((id) => {
            const it = ITEMS && ITEMS.find((x) => x.id === id);
            const d = r.done[id];
            return `<div class="rd-item ${d.ok ? 'ok' : 'no'}" data-rd="${id}">
              <span class="rd-mark">${d.ok ? '✓' : '✗'}</span>
              <span class="rd-src">${it ? it.src : id}</span>
              <span class="rd-pick">选了 ${d.pick}</span>
            </div>`;
          }).join('')
        : '');
    // 错题模式分析：近 20 篇记录（题干要点|我的答案|正确答案）→ 题型/错因/建议
    const pb = $('#rd-pattern-btn');
    if (pb) pb.addEventListener('click', () => {
      const pbox = $('#rd-pattern-box');
      if (!pbox.dataset.busy && !pbox.classList.contains('hidden') && pbox.innerHTML) { pbox.classList.add('hidden'); return; }
      const ids = doneIds.slice(0, 20);
      const lines = ids.map((id) => {
        const it2 = ITEMS && ITEMS.find((x) => x.id === id);
        const d2 = r.done[id];
        return (it2 ? it2.q.stem.slice(0, 70) : id) + ' | ' + d2.pick + ' | ' + (it2 ? it2.q.answer : '?');
      }).join('\n');
      StudyAI.ask('rdPattern', { records: lines }, pbox, '分析错题模式中…');
    });
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

  // 译文对照开关（记住偏好；默认关——做题时看翻译会剧透）
  function rdCnOn() { try { return localStorage.getItem('sgwd_rd_cn') === '1'; } catch (e) { return false; } }
  function setCnOn(v) { try { localStorage.setItem('sgwd_rd_cn', v ? '1' : '0'); } catch (e) { } }

  /** 原文渲染：开对照且译文段落与原文段落数一致 → 逐段交错；否则译文整体块跟在文末 */
  function rdTextHtml(it, showCn) {
    const en = it.text.split('\n').filter((p) => p.trim());
    const cn = (it.cn || '').split('\n').filter((p) => p.trim());
    if (showCn && it.cn && cn.length === en.length) {
      return en.map((p, i) => `<p class="rd-p">${wrapWords(p)}</p><p class="rd-p cn">${cn[i]}</p>`).join('');
    }
    let html = en.map((p) => `<p class="rd-p">${wrapWords(p)}</p>`).join('');
    if (showCn && it.cn) html += `<p class="rd-p cn rd-cn-fall">${it.cn.replace(/\n/g, '<br>')}</p>`;
    return html;
  }

  /** 简单句子切分（不用 lookbehind 正则——旧 WebView 会整文件语法报错）；缩写点会误切，容忍 */
  function splitSentences(para) {
    const out = [];
    let buf = '';
    for (const ch of para) {
      buf += ch;
      if (ch === '.' || ch === '!' || ch === '?') { const s = buf.trim(); if (s) out.push(s); buf = ''; }
    }
    const rest = buf.trim();
    if (rest) out.push(rest);
    return out;
  }

  /** 点词时定位所在句 + 前后文（句级 AI 讲解用） */
  function findSentence(para, word) {
    const ss = splitSentences(para);
    const w = String(word || '').toLowerCase();
    for (let i = 0; i < ss.length; i++) {
      if (ss[i].toLowerCase().indexOf(w) >= 0) {
        return { sent: ss[i], ctx: (ss[i - 1] ? ss[i - 1] : '') + (ss[i + 1] ? ' ' + ss[i + 1] : '') };
      }
    }
    return { sent: para, ctx: '' };
  }

  function renderQuiz(it, redo) {
    if (window.speechSynthesis) speechSynthesis.cancel(); // 换篇时停掉上一篇朗读
    $('#reading-list').classList.add('hidden');
    const box = $('#reading-quiz');
    box.classList.remove('hidden');
    delete box.dataset.answered; // 换篇重置答题标志（box 是固定元素，innerHTML 不清 dataset）
    box.classList.remove('show-cn');
    box.innerHTML = `
      <div class="rd-src-line">${it.src} · 约 ${it.words} 词
        <button class="rd-speak" id="rd-speak"> 朗读</button>
        <span class="rd-tts-ctrl hidden" id="rd-tts-ctrl">
          <button class="rd-speak" id="rd-pause"><i class="ico ls-ico" style="--ico:url(undefined)"></i>暂停</button>
          <button class="rd-speak" id="rd-stop"><i class="ico ls-ico" style="--ico:url(undefined)"></i>停止</button>
        </span>
      </div>
      <div class="rd-tools">
        <button class="rd-tool" id="rd-cn-sw">对照译文</button>
        <button class="rd-tool" id="rd-fullai">全文精讲</button>
      </div>
      <div class="rd-ai-box hidden" id="rd-fullai-box"></div>
      <div class="rd-text" id="rd-text"></div>
      <div class="rd-q">${it.q.stem}${it.q.stemCn ? `<div class="rd-q-cn">${it.q.stemCn}</div>` : ''}</div>
      <div class="rd-opts">${['A', 'B', 'C', 'D'].map((c, i) => {
        const cn = it.q.optionsCn && it.q.optionsCn[i];
        return `<button class="rd-opt" data-opt="${c}"><span class="opt-en"><b>${c}</b> ${wrapWords(it.q.options[i] || '')}</span>${cn ? `<span class="opt-cn">${cn}</span>` : ''}</button>`;
      }).join('')}
      </div>
      <div id="rd-result" class="hidden"></div>
      <div class="rd-actions hidden" id="rd-actions">
        <button class="primary-btn" id="rd-next">再来一篇</button>
        <button class="ghost-btn" id="rd-back">返回阅读页</button>
      </div>`;
    // 原文渲染 + 对照译文开关（切开关只换 innerHTML；点词监听挂在元素上只挂一次，重复挂会叠加触发）
    const cnSw = $('#rd-cn-sw');
    const applyCn = () => {
      const on = rdCnOn();
      $('#rd-text').innerHTML = rdTextHtml(it, on);
      box.classList.toggle('show-cn', on); // 题干/选项中文跟随同一开关
      cnSw.textContent = on ? '隐藏译文' : '对照译文';
      cnSw.classList.toggle('on', on);
    };
    $('#rd-text').addEventListener('click', (ev) => {
      const s = ev.target.closest('.rd-w');
      if (!s) return;
      const p = s.closest('.rd-p');
      const info = findSentence(p ? p.textContent : '', s.textContent);
      WordCard.show(s.textContent, info.sent, info.ctx);
    });
    applyCn();
    cnSw.addEventListener('click', () => { setCnOn(!rdCnOn()); applyCn(); });
    // 全文精讲（文章级：长难句/核心词/篇章脉络，云端缓存共享）
    const fa = $('#rd-fullai'), fab = $('#rd-fullai-box');
    fa.addEventListener('click', () => {
      if (!fab.classList.contains('hidden')) { fab.classList.add('hidden'); fa.textContent = '全文精讲'; return; }
      fa.textContent = '收起精讲';
      StudyAI.ask('rdFull', { text: it.text }, fab, '全文精讲生成中，约 10~20 秒…');
    });
    // 选项里的单词=查词（不答题，也不受"已答"影响）；点空白处才是答题
    box.addEventListener('click', (ev) => {
      const s = ev.target.closest('.rd-opt .rd-w');
      if (!s) return;
      const en = s.closest('.opt-en');
      const info = findSentence(en ? en.textContent : '', s.textContent);
      WordCard.show(s.textContent, info.sent, info.ctx);
    });
    box.querySelectorAll('.rd-opt').forEach((b) => b.addEventListener('click', (ev) => {
      if (ev.target.closest('.rd-w')) return; // 点在单词上=查词
      pick(it, b.dataset.opt);
    }));
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
      pauseBtn.textContent = '<i class="ico ls-ico" style="--ico:url(undefined)"></i>暂停';
    });
    pauseBtn.addEventListener('click', () => {
      if (ttsPaused) { speechSynthesis.resume(); pauseBtn.textContent = '<i class="ico ls-ico" style="--ico:url(undefined)"></i>暂停'; }
      else { speechSynthesis.pause(); pauseBtn.textContent = '<i class="ico ls-ico" style="--ico:url(undefined)"></i>继续'; }
      ttsPaused = !ttsPaused;
    });
    $('#rd-stop').addEventListener('click', () => { stopAll(); ttsReset(); });
    $('#rd-next').addEventListener('click', () => { start(); });
    $('#rd-back').addEventListener('click', () => { stopAll(); box.classList.add('hidden'); $('#reading-list').classList.remove('hidden'); renderPage(); });
    window.scrollTo({ top: 0 });
  }

  function pick(it, letter) {
    const pickBox = $('#reading-quiz');
    if (!pickBox || pickBox.dataset.answered === '1') return; // 防重入（替代 disabled：已答选项里的单词仍可点查）
    pickBox.dataset.answered = '1';
    const r = rState();
    const ok = letter === it.q.answer;
    // 记录（重做覆盖）
    r.done[it.id] = { pick: letter, ok, ts: Date.now() };
    saveState();
    // 渲染结果
    document.querySelectorAll('#reading-quiz .rd-opt').forEach((b) => {
      b.classList.add('answered');
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
      <button class="ghost-btn rd-ai-btn" id="rd-ai-explain">AI 深度讲解</button>
      <div class="rd-ai-box hidden" id="rd-ai-box"></div>
      <button class="ghost-btn rd-ai-btn" id="rd-quiz-btn">AI 出 3 道小练</button>
      <div class="rd-ai-box hidden" id="rd-quiz-box"></div>
      ${vocabHtml}
      ${cnHtml}`;
    // 逐题 AI 讲解（定位原句/解题逻辑/干扰项分析，云端缓存共享）
    const ax = $('#rd-ai-explain'), ab = $('#rd-ai-box');
    ax.addEventListener('click', () => {
      if (!ab.classList.contains('hidden')) { ab.classList.add('hidden'); ax.textContent = 'AI 深度讲解'; return; }
      ax.textContent = '收起讲解';
      StudyAI.ask('rdExplain', { text: it.text, q: it.q.stem, opts: it.q.options, ans: it.q.answer }, ab, '生成讲解中，约 10 秒…');
    });
    // AI 出 3 道小练（词汇/短语/句子理解，云端缓存共享；即时判分不进 SRS）
    const qb = $('#rd-quiz-btn'), qbox = $('#rd-quiz-box');
    qb.addEventListener('click', () => {
      if (!qbox.classList.contains('hidden')) { qbox.classList.add('hidden'); qb.textContent = 'AI 出 3 道小练'; return; }
      qb.textContent = '收起小练';
      StudyAI.ask('rdQuiz', { text: it.text }, qbox, '出题中，最长约 1 分钟…', renderRdQuiz);
    });
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
    if (head) head.textContent = `阅读生词（${words.length}）`;
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
        audio.addEventListener('play', () => { const b = $('#ls-play'); if (b) b.textContent = '<i class="ico ls-ico" style="--ico:url(undefined)"></i>暂停'; });
        audio.addEventListener('pause', () => { const b = $('#ls-play'); if (b) b.textContent = '<i class="ico ls-ico" style="--ico:url(undefined)"></i>播放'; });
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
          <button class="mini-btn" id="ls-play"><i class="ico ls-ico" style="--ico:url(undefined)"></i>播放</button>
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
          <button class="lw-close"><i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M18 6L6 18M6 6l12 12%27/%3E%3C/svg%3E&quot;)"></i></button></div>
        <div class="lw-cn">${esc(cn)}</div>
        <div class="lw-root">${esc((hit.w.root || '').slice(0, 90))}</div>`;
    } else {
      card.innerHTML = `<div class="lw-head"><b>${esc(raw)}</b><button class="lw-close"><i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%272.2%27 stroke-linecap=%27round%27%3E%3Cpath d=%27M18 6L6 18M6 6l12 12%27/%3E%3C/svg%3E&quot;)"></i></button></div>
        <div class="lw-cn">词库（${totalWords()} 词）里没有这个词，先按发音记一下。</div>`;
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
      if (nxt) { stopAudio(); openTask(nxt); } else { toast('这一套练完了'); stopAudio(); renderGroups(); }
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
    if (head) head.textContent = `听力生词（${ws.length}）`;
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
    // 只写设置页的状态行；待办页副标题由 renderTodoRemBar() 独立渲染，
    // 这里串写会把两页文案互相覆盖（"正在开启…"盖掉"每日 20:00 提醒"）
    const el = $('#rem-status');
    if (el) {
      el.textContent = msg;
      el.className = 'set-note' + (cls ? ' ' + cls : '');
    }
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
    // 待办事项上传服务端：关闭软件后的到点提醒由服务端定时器负责（此前迁移遗漏的能力缺口）
    const todo = (Array.isArray(state.todo) ? state.todo : []).map((x) => ({
      id: String(x.id || ''),
      text: String(x.text || '').slice(0, 40),
      type: x.type === 'once' || x.type === 'weekly' ? x.type : 'daily',
      date: String(x.date || '').slice(0, 10),
      time: String(x.time || '20:00').slice(0, 5),
      wd: Number(x.wd) || 0,
      done: !!x.done,
      todayDone: String(x.todayDone || '').slice(0, 10),
    })).filter((x) => x.id);
    return {
      time: r.time || '20:00', smart: r.smart !== false, enabled: !!r.enabled,
      lastActive: Date.now(), learnedTotal, todo,
      partnerName: (state.sync && state.sync.partnerName) || '', // 我给好友的备注名（对方端通知文案用）
    };
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
        why = isIOS() ? '还没把本应用「添加到主屏幕」' : '这台浏览器拿不到系统通知';
      }
      if (!pushOK && !ntfyOn && !state.sync.pushplusToken && !Sync.isShell()) {
        const guide = isIOS()
          ? 'iPhone：请先「添加到主屏幕」并从主屏图标打开、允许通知。'
          : '安卓：装「 安卓 App 安装包」（最省心），或到下面「 微信通知」粘贴 PushPlus 口令。';
        setStatus('这台设备现在还收不到提醒（' + why + '）。' + guide, 'err');
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
        setStatus('这台设备两条通道都还没配：安卓请到「 安卓通知(ntfy)」生成主题并在 ntfy App 里订阅；iPhone 请重新开启上面的提醒开关', 'err');
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
    else if (!isStandalone()) {
      if (isIOS()) setStatus('提示：先「添加到主屏幕」，从主屏图标打开后再开启提醒', '');
      else if (Sync.isShell()) setStatus('通知走 App 系统通知（无需额外设置）；也可在下方配微信通道', '');
      else setStatus('这台安卓设备建议：装「安卓 App 安装包」（通知最稳），或在下方配微信通道', '');
    }
    if (r.enabled) repairPush(); // 启动自愈：旧订阅密钥不匹配时自动重建（换后端后必备）
    // 启动即上传一次待办（关闭软件后的待办到点提醒由服务端负责；不碰待办也要保证服务端有最新数据）
    if (state.sync && state.sync.code) setTimeout(() => sync(true), 3000);
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
          <button class="wcbtn wcspeak"> 发音</button>
          <button class="wcbtn wcai">AI 讲解</button>
          <button class="wcbtn wcfav">☆ 收藏生词</button>
        </div>
        <button class="wcbtn wcsent-btn hidden">AI 讲这句话</button>
        <div class="wcsent hidden"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.wcmask').addEventListener('click', hide);
    el.querySelector('.wcclose').addEventListener('click', hide);
    el.querySelector('.wcspeak').addEventListener('click', () => { if (el.dataset.w) speak(el.dataset.w); });
    el.querySelector('.wcai').addEventListener('click', () => { if (el.dataset.w) { WordCard.hide(); aiExplainWord(el.dataset.w); } });
    el.querySelector('.wcfav').addEventListener('click', toggleFav);
    el.querySelector('.wcsent-btn').addEventListener('click', () => {
      const sbox = el.querySelector('.wcsent');
      const btn = el.querySelector('.wcsent-btn');
      if (!sbox.classList.contains('hidden')) { sbox.classList.add('hidden'); btn.textContent = 'AI 讲这句话'; return; }
      btn.textContent = '收起讲解';
      StudyAI.ask('rdSent', { sent: el.dataset.sent, ctx: el.dataset.ctx }, sbox, '句子讲解生成中…');
    });
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
  async function show(word, sent, ctx) {
    const box = ensure();
    const w = String(word || '').toLowerCase().replace(/[^a-z'\-]/g, '');
    if (!w) return;
    box.dataset.w = w;
    box.dataset.cn = '';
    box.dataset.sent = String(sent || '');
    box.dataset.ctx = String(ctx || '');
    const sb = box.querySelector('.wcsent-btn');
    const sbox = box.querySelector('.wcsent');
    if (sent) { sb.classList.remove('hidden'); sb.textContent = 'AI 讲这句话'; }
    else { sb.classList.add('hidden'); }
    sbox.classList.add('hidden');
    sbox.innerHTML = '';
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
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.target.blur(); }
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
  const wordsSub = $('#home-words-sub');
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
    let learnedTotal = 0;
    for (const k in state.learned) learnedTotal += countKeys(state.learned, k);
    if (wordsSub) wordsSub.textContent = `已学 ${learnedTotal}/${totalWords()} · 继续 ${u.name}${pos}`;
  } else {
    b.classList.add('hidden');
    if (wordsSub) wordsSub.textContent = '选择单元开始学习';
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
  sub.textContent = parts.length ? parts.join(' · ') : '点进去配置你今天的目标';
  badge.textContent = due > 0 ? String(due) : '✓';
  badge.classList.remove('hidden');
  badge.classList.toggle('today-clear', due === 0 && (dt.length ? dailyDoneCount() === dt.length : true));
  const rb = $('#today-start-review');
  if (rb) rb.textContent = due > 0 ? `开始复习（${due} 词）` : '今日复习已清空 ✓';
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
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-go="newword"><span class="ti-ico">${ok ? '<b class="ok">✓</b>' : '<i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M4 19.5A2.5 2.5 0 0 1 6.5 17H20%27/%3E%3Cpath d=%27M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z%27/%3E%3C/svg%3E&quot;)"></i>'}</span><span class="ti-text">背新词</span><span class="ti-num">${t.n}/${c.newWords.goal}</span></div>`);
  }
  if (c.review.on) {
    const due = srsDueCapped().length;
    rows.push(`<div class="today-item ${due === 0 ? 'done' : ''}" data-go="review"><span class="ti-ico">${due === 0 ? '<b class="ok">✓</b>' : ''}</span><span class="ti-text">复习到期词</span><span class="ti-num">${due}${c.review.cap > 0 && srsDueList().length > c.review.cap ? '（总' + srsDueList().length + '，今日上限' + c.review.cap + '）' : ''}</span></div>`);
  }
  if (c.reading.on) {
    const n = readingDoneToday();
    const ok = n >= c.reading.goal;
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-go="reading"><span class="ti-ico">${ok ? '<b class="ok">✓</b>' : '<i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M4 19.5A2.5 2.5 0 0 1 6.5 17H20%27/%3E%3Cpath d=%27M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z%27/%3E%3C/svg%3E&quot;)"></i>'}</span><span class="ti-text">阅读随手练</span><span class="ti-num">${n}/${c.reading.goal}</span></div>`);
  }
  if (c.listening.on) {
    const n = listeningDoneToday();
    const ok = n >= c.listening.goal;
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-go="listening"><span class="ti-ico">${ok ? '<b class="ok">✓</b>' : '<i class="ico" style="--ico:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23000%27 stroke-width=%271.9%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M3 18v-6a9 9 0 0 1 18 0v6%27/%3E%3Cpath d=%27M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3v5z%27/%3E%3C/svg%3E&quot;)"></i>'}</span><span class="ti-text">听力精听</span><span class="ti-num">${n}/${c.listening.goal}</span></div>`);
  }
  dailyTasks().forEach((t) => {
    const ok = dailyTaskDone(t);
    rows.push(`<div class="today-item ${ok ? 'done' : ''}" data-dtask="${t.id}"><span class="ti-ico">${ok ? '<b class="ok">✓</b>' : ''}</span><span class="ti-text">${esc(t.text)}</span><span class="ti-num">${ok ? '已完成' : '点一下打勾'}</span></div>`);
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
      startTest(q, `今日复习 ${q.length} 词`, 'srs');
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

/* ================= 首页二级面板（主页条目 → 面板切换） ================= */
function showHomePanel(name) {
  const home = $('#home-main');
  if (!home) return;
  $$('#view-units .set-panel').forEach((p) => p.classList.add('hidden'));
  if (!name) { home.classList.remove('hidden'); return; }
  home.classList.add('hidden');
  const el = $('#homepanel-' + name);
  if (el) el.classList.remove('hidden');
  window.scrollTo({ top: 0 });
}
$('#home-main').addEventListener('click', (e) => {
  const b = e.target.closest('[data-homepanel]');
  if (!b) return;
  showHomePanel(b.dataset.homepanel);
  if (b.dataset.homepanel === 'todo') renderTodo(); // 待办列表随面板打开刷新
  if (b.dataset.homepanel === 'daily') Daily.open(); // 每日精进：打开即拉取
});
$$('#view-units [data-homeback]').forEach((b) => b.addEventListener('click', () => showHomePanel(null)));
// 今日任务卡：改为进面板（面板里有清单与「开始复习」）
$('#today-card').addEventListener('click', () => showHomePanel('today'));
$('#today-start-review').addEventListener('click', () => {
  const q = srsDueCapped();
  if (!q.length) { toast('今日复习已清空 ✓ 去完成清单里的其它任务吧'); return; }
  startTest(q, `今日复习 ${q.length} 词`, 'srs');
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


/* ================= AI 学习助手 ================= */
const AI = (() => {
  const HIST_KEY = 'sgwd_ai_hist';
  let sending = false;

  function hist() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveHist(h) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-60))); } catch (e) { }
  }

  /** 进度上下文：AI 知道你在学什么 */
  function contextSummary() {
    const bits = [];
    try {
      let learned = 0;
      for (const k in state.learned) learned += countKeys(state.learned, k);
      bits.push(`已学 ${learned}/${totalWords()} 词`);
      const u = state.lastUnit && unitById(state.lastUnit);
      if (u) bits.push(`最近在学 ${u.name}`);
      const t = todayCount();
      bits.push(`今日新词 ${t.n}、复习 ${t.r}`);
      const due = srsDueCapped().length;
      if (due) bits.push(`待复习 ${due} 词`);
    } catch (e) { }
    return bits.join('，');
  }

  /* 轻量 Markdown 渲染（AI 回复排版）：先转义防 XSS，再行级转换。
     11 种语法：标题/列表/有序列表/hr/粗体/引用/删除线/行内代码/围栏代码块/表格/链接（仅 http/s）。
     围栏代码块先整段摘为占位符，避免块内语法被误解析（问史同款方案）。 */
  function mdInline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code class="md-code-i">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function mdTable(rows) {
    const cells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => mdInline(c.trim()));
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    const th = head.map((c) => '<th>' + c + '</th>').join('');
    const tb = body.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('');
    return '<div class="md-tbl-wrap"><table class="md-tbl"><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table></div>';
  }
  function mdLite(raw) {
    const codes = [];
    const s0 = String(raw || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      codes.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });
    const t = esc(s0);
    const restore = (x) => x.replace(/\u0000C(\d+)\u0000/g, (m, i) => {
      const c = codes[Number(i)] || { lang: '', code: '' };
      return '<div class="md-code"><div class="md-code-lang">' + c.lang + '</div><pre>' + c.code + '</pre></div>';
    });
    const lines = t.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const x = lines[i].trim();
      if (!x) { out.push('<div class="md-gap"></div>'); continue; }
      if (/^-{3,}$/.test(x) || /^\*{3,}$/.test(x)) { out.push('<hr class="md-hr">'); continue; }
      const h = x.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out.push('<div class="md-h md-h' + h[1].length + '">' + mdInline(h[2]) + '</div>'); continue; }
      const li = x.match(/^[-*•]\s+(.*)$/);
      if (li) { out.push('<div class="md-li">' + mdInline(li[1]) + '</div>'); continue; }
      const oli = x.match(/^(\d{1,2})[.、)]\s+(.*)$/);
      if (oli) { out.push('<div class="md-li md-oli"><b>' + oli[1] + '.</b> ' + mdInline(oli[2]) + '</div>'); continue; }
      const q = x.match(/^&gt;\s?(.*)$/);
      if (q) { out.push('<blockquote class="md-quote">' + mdInline(q[1]) + '</blockquote>'); continue; }
      /* 表格块：当前行以 | 开头且下一行是 |---| 分隔行 */
      if (x.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].trim().indexOf('-') >= 0) {
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
        i--;
        out.push(restore(mdTable(rows)));
        continue;
      }
      if (/^\u0000C\d+\u0000$/.test(x)) { out.push(restore(x)); continue; }
      out.push('<p class="md-p">' + mdInline(x) + '</p>');
    }
    return restore(out.join(''));
  }

  /* ================= 应用操控（vf-action 协议） =================
     AI 在回复末尾输出 <vf-action>{"op":...}</vf-action>，前端白名单解析执行。
     只允许低危操作（收藏/星级/已学/错词/复习/检验/跳转），每轮最多 3 个；
     词必须能在词库定位，否则该条跳过并回执失败原因。历史里只存剥离指令后的纯文本。 */
  const ACTION_RE = /<vf-action>\s*(\{[\s\S]*?\})\s*<\/vf-action>/g;
  function parseActions(raw) {
    const acts = [];
    let m;
    ACTION_RE.lastIndex = 0;
    while ((m = ACTION_RE.exec(String(raw || ''))) && acts.length < 3) {
      try { acts.push(JSON.parse(m[1])); } catch (e) { /* 坏 JSON 不执行也不剥离 */ }
    }
    return acts;
  }
  function stripActions(raw) {
    return String(raw || '').replace(/<vf-action>\s*(\{[\s\S]*?\})\s*<\/vf-action>\s*/g, (mm, j) => {
      try { JSON.parse(j); return ''; } catch (e) { return mm; } // 只有合法指令才从正文剥离
    }).trim();
  }
  function findWord(word) {
    const k = wordKey(String(word || '').trim());
    if (!k) return null;
    for (const u of DATA.units) {
      const w = u.words.find((x) => wordKey(x.w) === k);
      if (w) return { unitId: u.id, w: w.w };
    }
    return null;
  }
  /** 执行单条指令，返回回执文本；不合法抛 Error（消息给用户看） */
  function execAction(a) {
    const op = String(a && a.op || '');
    const KNOWN = ['fav', 'unfav', 'star', 'learn', 'unlearn', 'master', 'review', 'quiz', 'nav'];
    if (KNOWN.indexOf(op) < 0) throw new Error('未知操作：' + op); // 白名单前置：删数据类操作永远到不了这里
    if (op === 'review') {
      const q = srsDueCapped();
      if (!q.length) return '今日没有到期的复习词';
      startTest(q, '今日复习 ' + q.length + ' 词', 'srs');
      return '已开始今日复习（' + q.length + ' 词）';
    }
    if (op === 'quiz') {
      const n = Number(a.unit);
      const u = (n >= 1 && n <= DATA.units.length) ? DATA.units[n - 1] : DATA.units[Math.floor(Math.random() * DATA.units.length)];
      startTest(buildQueueByUnit(u.id), u.name + ' 检验', 'unit:' + u.id);
      return '已开始「' + u.name + '」检验';
    }
    if (op === 'nav') {
      const views = ['units', 'favorites', 'reading', 'listening', 'settings'];
      const v = String(a.view || '');
      if (views.indexOf(v) < 0) throw new Error('不支持的页面：' + v);
      nav(v);
      return '已跳转';
    }
    const f = findWord(a.word);
    if (!f) throw new Error('词库中没有「' + a.word + '」');
    const id = f.unitId, w = f.w;
    if (op === 'fav') {
      if (isFav(id, w)) return '「' + w + '」已在收藏夹';
      setFav(id, w, true); saveState();
      return '已收藏「' + w + '」';
    }
    if (op === 'unfav') {
      if (!isFav(id, w)) return '「' + w + '」本就不在收藏夹';
      setFav(id, w, false); saveState();
      return '已取消收藏「' + w + '」';
    }
    if (op === 'star') {
      const v = Math.max(1, Math.min(3, Number(a.v) || 1));
      if (!isFav(id, w)) setFav(id, w, true); // 星级挂在收藏上：未收藏先收藏
      setFavStar(id, w, v); saveState();
      return '「' + w + '」熟练度已设为 ' + v + ' 星';
    }
    if (op === 'learn') {
      setLearned(id, w, true); setWrong(id, w, false);
      srsInit(id, w); logLearn('n'); saveState();
      if (typeof renderToday === 'function') renderToday();
      return '已标记「' + w + '」为已学（明天进入复习）';
    }
    if (op === 'unlearn') {
      setLearned(id, w, false); srsRemove(id, w); saveState();
      return '已取消「' + w + '」的已学标记';
    }
    if (op === 'master') {
      if (!isWrong(id, w)) return '「' + w + '」不在错词本';
      setWrong(id, w, false); saveState();
      return '「' + w + '」已移出错词本';
    }
    throw new Error('未知操作：' + op); // 不可达（白名单前置），兜底
  }
  /** 顺序执行指令并在最后一条回复气泡后追加回执条 */
  function runActions(acts) {
    const box = $('#ai-msgs');
    if (!box) return;
    const bar = document.createElement('div');
    bar.className = 'vf-action-bar';
    bar.innerHTML = '<div class="vf-action-head">⚡ 已执行应用操作</div>';
    let okN = 0;
    acts.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'vf-action-row';
      try {
        const msg = execAction(a);
        okN++;
        row.innerHTML = '<span class="ok">✓</span> ' + esc(msg);
      } catch (e) {
        row.innerHTML = '<span class="no">✗</span> ' + esc(String(e.message || e).slice(0, 80));
      }
      bar.appendChild(row);
    });
    box.appendChild(bar);
    box.scrollTop = box.scrollHeight;
    buzz(okN ? 15 : [30, 50, 30]);
  }

  function renderMsgs() {
    const box = $('#ai-msgs');
    if (!box) return;
    const h = hist();
    if (!h.length) {
      box.innerHTML = `<div class="ai-empty">你好呀 🌸 我是你的 AI 学习助手。<br>可以问我：单词含义/记忆技巧、语法、长难句分析、真题翻译…<br>我大致知道你的学习进度（${esc(contextSummary()) || '刚上手'}）。</div>`;
    } else {
      box.innerHTML = h.map((m, idx) => m.role === 'user'
        ? `<div class="ai-msg user"><span class="ai-user-txt">${esc(m.content)}</span><button class="msg-edit" data-edit="${idx}" title="编辑重发">✎</button></div>`
        : `<div class="ai-msg bot">${mdLite(m.content)}</div>`).join('');
    }
    box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editResend(Number(b.dataset.edit))));
    const chips = $('#ai-chips');
    if (chips) {
      const u = state.lastUnit && unitById(state.lastUnit);
      const lastWord = window.__aiWord || (u && u.words[0] && u.words[0].w);
      const qs = [
        lastWord ? `讲解单词 ${lastWord}（词源/辨析/记忆技巧/例句）` : '讲一个考研高频词',
        '易混词辨析：affect vs effect',
        '分析一个考研长难句并教我拆解方法',
        '我今天的复习计划建议',
      ];
      chips.innerHTML = qs.map((q) => `<button class="mini-btn" data-aiq="${esc(q)}">${esc(q.length > 16 ? q.slice(0, 15) + '…' : q)}</button>`).join('');
      chips.querySelectorAll('[data-aiq]').forEach((b) => b.addEventListener('click', () => send(b.dataset.aiq)));
    }
    box.scrollTop = box.scrollHeight;
    window.scrollTo({ top: document.body.scrollHeight });
    restoreLeft();
  }

  /* 编辑重发：删除该条及其后所有消息，原文塞回输入框，改完再发 */
  function editResend(idx) {
    if (sending) { toast('等这轮回答完再编辑'); return; }
    const h = hist();
    if (!h[idx] || h[idx].role !== 'user') return;
    const raw = h[idx].content;
    saveHist(h.slice(0, idx));
    const input = $('#ai-input');
    if (input) { input.value = raw; try { input.focus(); } catch (e) { } }
    renderMsgs();
  }

  /** 错误分类文案（服务端 AI_AUTH/AI_RATE/AI_MODEL/AI_UPSTREAM/LIMIT/NO_KEY/TIMEOUT 同一套契约） */
  function errText(e) {
    const code = e && e.code;
    const m = String((e && e.message) || e);
    if (code === 'ABORTED') return '';
    if (code === 'LIMIT') return '今天次数用完了（每天 100 次）';
    if (code === 'NO_KEY') return 'AI 还没配置好（找青峰放 Key）';
    if (code === 'AI_AUTH') return 'AI 密钥失效（' + m.slice(0, 90) + '）';
    if (code === 'AI_RATE') return 'AI 正被限流，等十几秒再试';
    if (code === 'AI_MODEL') return '模型不可用：' + m.slice(0, 90);
    if (code === 'AI_UPSTREAM' || code === 'AI_EMPTY') return 'AI 服务异常：' + m.slice(0, 90);
    if (code === 'TIMEOUT' || code === 'NO_STREAM') return '网络不通（' + m.slice(0, 60) + '）';
    return m.slice(0, 90);
  }

  /** 握手类失败自动重试（仅网络/上游瞬时错误；限额、密钥、内容类不重试） */
  function isRetryable(e) {
    return e && (e.code === 'TIMEOUT' || e.code === 'NO_STREAM' || e.code === 'AI_UPSTREAM');
  }

  /** 上下文折叠：12 条窗口外的早期用户提问压成清单，随 earlier 上传（不静默丢失） */
  function earlierDigest(h) {
    const win = h.slice(-12);
    const cut = h.length - win.length;
    if (cut <= 0) return { msgs: h, earlier: '' };
    const items = [];
    for (let i = 0; i < cut; i++) {
      if (h[i].role === 'user') items.push((items.length + 1) + '. ' + h[i].content.slice(0, 40));
    }
    return { msgs: win, earlier: items.slice(-15).join('\n') };
  }

  let abortCtrl = null; // 当前流式请求的中止句柄（发送键在生成中=停止键）

  async function send(text) {
    const input = $('#ai-input');
    const msg = String(text !== undefined ? text : (input && input.value) || '').trim();
    // 生成中：程序化调用（词卡讲解等）静默忽略；「停止」只在按钮/回车层处理（见 bind）
    if (!msg || sending) return;
    if (input) input.value = '';
    const h = hist();
    h.push({ role: 'user', content: msg });
    saveHist(h);
    renderMsgs();
    sending = true;
    setSendMode('stop');
    const box = $('#ai-msgs');
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg bot ai-loading';
    bubble.textContent = '思考中…';
    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight;
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (bubble.isConnected && !bubble.dataset.streaming) bubble.textContent = Math.round((Date.now() - t0) / 1000) + 's · 正在思考…';
    }, 500);
    // 流式增量渲染（节流 100ms，结束补一次全量）。
    // paintText：流式期间不显示操作指令（已闭合的整段和尾部半截 <vf-action 都不显示，避免闪现）
    let raw = '', raf = 0;
    const paintText = (s) => s.replace(/<vf-action>\s*\{[\s\S]*?\}\s*<\/vf-action>\s*/g, '').replace(/<vf-action>[\s\S]*$/, '');
    const paint = (final) => {
      bubble.dataset.streaming = '1';
      bubble.classList.remove('ai-loading');
      bubble.innerHTML = AI.mdLite(paintText(raw)) + (final ? '' : '<span class="md-caret"></span>');
      box.scrollTop = box.scrollHeight;
    };
    const onDelta = (piece, full) => {
      raw = full;
      if (!raf) raf = setTimeout(() => { raf = 0; paint(false); }, 100);
    };
    abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const finish = (reply) => {
      if (raf) { clearTimeout(raf); raf = 0; } // 清掉未执行的节流 render，防游离 paint
      const acts = parseActions(reply);
      const clean = acts.length ? stripActions(reply) : reply;
      const h2 = hist();
      h2.push({ role: 'assistant', content: clean });
      saveHist(h2);
      clearInterval(tick);
      sending = false;
      abortCtrl = null;
      setSendMode('send');
      renderMsgs();
      if (acts.length) setTimeout(() => runActions(acts), 100); // 渲染完再执行（quiz/review 会切页）
      const live = document.getElementById('sr-live');
      if (live) live.textContent = clean; // 读屏只播最新一条
    };
    const { msgs, earlier } = earlierDigest(hist());
    const payload = { messages: msgs, context: contextSummary(), earlier };
    let attempt = 0;
    while (true) {
      try {
        let r = null;
        try {
          r = await (typeof Sync !== 'undefined' && Sync.streamChat
            ? Sync.streamChat(payload, onDelta, abortCtrl ? abortCtrl.signal : undefined)
            : Promise.reject(Object.assign(new Error('无流式通道'), { code: 'NO_STREAM' })));
        } catch (se) {
          if (se.code === 'ABORTED') { finish(se.partialText || raw || '（已停止）'); return; }
          // 流式通道不可达/异常 → 降级走原非流式（业务类错误码不降级，如实报错）
          const BIZ = ['LIMIT', 'NO_KEY', 'AI_AUTH', 'AI_RATE', 'AI_MODEL', 'BAD_CODE', 'BAD_MSGS', 'NO_SUCH_CODE'];
          if (attempt === 0 && BIZ.indexOf(se.code) < 0) {
            attempt++;
            r = await Sync.request('ai.chat', payload, 90000);
          } else throw se;
        }
        if (r && r.left != null) showLeft(r.left);
        const replyTxt = (r && r.text) || '（AI 没有返回内容，再试一次）';
        finish(r && r.partial ? replyTxt + '\n\n（回答中断，内容可能不完整）' : replyTxt);
        return;
      } catch (e) {
        if (e.code === 'ABORTED') { finish(e.partialText || raw || '（已停止）'); return; }
        attempt++;
        if (attempt <= 2 && isRetryable(e)) { // 网络类失败自动重试（指数退避）
          await new Promise((r2) => setTimeout(r2, 700 * attempt));
          continue;
        }
        const txt = errText(e);
        clearInterval(tick);
        sending = false;
        abortCtrl = null;
        setSendMode('send');
        if (txt) {
          const h3 = hist();
          h3.push({ role: 'assistant', content: '请求失败：' + txt });
          saveHist(h3);
        }
        renderMsgs();
        return;
      }
    }
  }

  /** 发送键双态：send=发消息 / stop=停止生成 */
  function setSendMode(mode) {
    const btn = $('#ai-send');
    if (!btn) return;
    btn.classList.toggle('stopping', mode === 'stop');
    btn.innerHTML = mode === 'stop' ? '■<span class="ai-stop-txt">停止</span>' : '发送';
  }

  function showLeft(left) {
    if (left == null) return;
    const el = $('#ai-left');
    if (el) el.textContent = '今日剩余 ' + left + ' 次';
    try { localStorage.setItem('sgwd_ai_left', String(left)); } catch (e) { }
  }
  /** 进 AI 页恢复上次已知额度（还没请求过就不显示） */
  function restoreLeft() {
    const el = $('#ai-left');
    if (!el || el.textContent) return;
    try {
      const v = localStorage.getItem('sgwd_ai_left');
      if (v != null) el.textContent = '今日剩余 ' + v + ' 次';
    } catch (e) { }
  }


  /** 从别的页面带着预设问题跳进来（词卡讲解 / 错词记忆）。
      记住来源页：看完讲解点「‹ 返回」回来源，而不是掉回首页。 */
  let returnView = null;
  function askWith(question) {
    if (currentView !== 'ai') returnView = currentView;
    nav('ai');
    if (sending) { toast('AI 正在回答上一个问题，稍等一下再点'); return; }
    setTimeout(() => send(question), 150);
  }
  /** AI 页返回键显隐 + 目标（有跳入来源才显示） */
  function applyBackBtn() {
    const btn = document.getElementById('ai-back');
    if (!btn) return;
    if (returnView && returnView !== 'ai') {
      btn.classList.remove('hidden');
      btn.dataset.nav = returnView;
    } else {
      btn.classList.add('hidden');
    }
  }

  function bind() {
    const btn = $('#ai-send');
    if (btn) btn.addEventListener('click', () => {
      if (sending) { if (abortCtrl) abortCtrl.abort(); return; } // 生成中=停止键
      send();
    });
    const input = $('#ai-input');
    if (input) input.addEventListener('keydown', (e) => {
      // isComposing：中文输入法回车是"确认候选词"，不能当发送（防误触）
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!sending) send(); }
    });
    const clear = $('#ai-clear');
    if (clear) clear.addEventListener('click', () => {
      if (!hist().length) return;
      if (confirm('清空 AI 对话记录？')) { localStorage.removeItem(HIST_KEY); renderMsgs(); }
    });
  }

  const backBtn = document.getElementById('ai-back');
  if (backBtn) backBtn.addEventListener('click', () => { returnView = null; }); // data-nav 委托负责跳转
  return { bind, renderMsgs, askWith, send, mdLite, showLeft, parseActions, stripActions, execAction, findWord, applyBackBtn };
})();

/* 对外快捷入口：词卡讲解 / 错词记忆 */
function aiExplainWord(w) {
  AI.askWith(`详细讲解考研单词 "${w}"：词源拆解、常见搭配、易混词辨析、一个巧记方法和两个真题级例句（带中文）。`);
}
function aiRememberWord(w) {
  AI.askWith(`我总是记不住单词 "${w}"，请给我一个强记忆锚点（谐音/画面/词根联想都行），越生动越好，并给一个用了这个锚点的例句。`);
}

/* ================= 启动 ================= */
// iOS Safari：挂一个 touch 监听后 :active 按压反馈才会生效
document.addEventListener('touchstart', () => {}, { passive: true });

/** 安卓壳版本比对：有新版 → 设置页红字 + 一键更新按钮（返回 true=有新版） */
function showApkUpdate(v) {
  try {
    const sh = window.vfShell;
    const local = sh && typeof sh.apkVer === 'function' ? String(sh.apkVer() || '') : null;
    if (local === null || !v || !v.apk || v.apk === local) return false;
    const st = $('#apk-ver-state');
    if (st) {
      st.innerHTML = '检测到 App 有新版本 <button class="ghost-btn" id="apk-update-now" style="padding:5px 14px">一键更新</button>';
      st.style.color = '#d84c4c';
      st.style.fontWeight = '700';
      const ub = $('#apk-update-now');
      if (ub) ub.addEventListener('click', () => {
        try {
          if (sh && typeof sh.updateNow === 'function') { sh.updateNow(); return; }
          // 旧壳没有 updateNow：转系统浏览器下载安装包
          location.href = './android/vocab-flash.apk';
        } catch (e) { toast('更新失败，请手动下载 APK 安装'); }
      });
    }
    return true;
  } catch (e) { return false; }
}

// 常驻「检查更新」按钮（安卓 App 内可用）
$('#apk-check').addEventListener('click', async () => {
  if (!(window.vfShell && typeof window.vfShell.apkVer === 'function')) { toast('此功能在安卓 App 内使用（网页版自动更新，无需操作）'); return; }
  toast('正在检查更新…');
  try {
    const v = await (await fetch('version.json', { cache: 'no-cache' })).json();
    if (showApkUpdate(v)) return;
    const st = $('#apk-ver-state');
    if (st) { st.textContent = '已是最新版 ✓'; st.style.color = ''; st.style.fontWeight = ''; }
    toast('已是最新版 ✓');
  } catch (e) { toast('检查失败，请联网后重试'); }
});

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
      if (seen && seen !== v.v) toast(` 已更新到 v${v.v}`);
      localStorage.setItem('sgwd_seen_ver', v.v);
      // 安卓壳：比对安装包版本，有新版时红字提示重装（壳自己也会发系统通知）
      showApkUpdate(v);
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
  AI.bind();
  AI.renderMsgs();
  Reading.bind();
  Reading.renderHome();
  Listening.bind();
  Listening.renderHome();
  Daily.init();

  // 从通知/桌面快捷方式点进来：?view=todo|favorites|wrong|units|settings 直达对应页
  try {
    const qv = new URLSearchParams(location.search).get('view');
    if (qv && ['todo', 'favorites', 'wrong', 'units', 'settings', 'daily'].includes(qv)) nav(qv);
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
