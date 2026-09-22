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
  settings: { rate: 0.9, fontSize: 17, sakura: true },
  scrolls: {},   // unitId(str) -> 学习页滚动位置
  lastUnit: null,
  reminder: { id: '', enabled: false, time: '20:00', smart: true },  // 推送提醒
  todo: [],      // 待办清单 [{id,text,type:'once'|'daily'|'weekly',date?,time,wd?,done?,todayDone?,createdAt}]
  reading: { done: {}, vocab: {} },  // 阅读随手练 done:{id:{pick,ok,ts}} vocab:{word:{cn,ts}}
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
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  if (typeof Reminder !== 'undefined') Reminder.ping(); // 学习动作后上报（自带节流）
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
function setWrong(id, w, v) { const m = wrongMap(id); if (v) m[wordKey(w)] = true; else delete m[wordKey(w)]; }
/* 收藏 */
function favMap(id) { return state.favorites[String(id)] || (state.favorites[String(id)] = {}); }
function isFav(id, w) { return !!favMap(id)[wordKey(w)]; }
function setFav(id, w, v) { const m = favMap(id); if (v) m[wordKey(w)] = true; else delete m[wordKey(w)]; }
function countKeys(store, id) {
  const v = store[String(id)];
  if (!v) return 0;
  return Array.isArray(v) ? v.length : Object.keys(v).length;  // 兼容旧数组格式
}

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
  if (currentView === 'study' && view !== 'study') {
    saveStudyPos();                    // 离开学习页前保存精确位置（词级）
    if (view === 'units') inStudy = false; // 只有主动回列表才算退出学习态
  }
  currentView = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (el) el.classList.remove('hidden');
  $$('#tabbar .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === view || (view === 'study' && b.dataset.nav === 'units'));
  });
  if (TAB_VIEWS.includes(view)) window.scrollTo({ top: 0 });
  if (view === 'units' && typeof renderContinue === 'function') renderContinue();
  if (view === 'units') Reading.renderHome();
  if (view === 'wrong') { renderWrongList(); Reading.renderWrongVocab(); }
  if (view === 'favorites' && typeof renderFavorites === 'function') renderFavorites();
  if (view === 'todo') { renderTodo(); renderTodoRemBar(); }
  if (view === 'reading') Reading.renderPage();
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
window.addEventListener('scroll', () => {
  if (currentView !== 'study' || studyUnitId == null) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveStudyPos, 250);
}, { passive: true });

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
    const rows = [];
    if (w.root) rows.push(`<div class="row"><span class="lab ji">记</span>${w.root}</div>`);
    if (w.exs && w.exs.length) {
      rows.push(`<div class="row"><span class="lab">例</span></div>` + w.exs.map((x) => `<div class="wc-ex">${x}</div>`).join(''));
    }
    if (w.fam) rows.push(`<div class="row"><span class="lab zu">族</span>${w.fam}</div>`);
    if (w.syn) rows.push(`<div class="row"><span class="lab li">近</span>${w.syn}</div>`);
    if (w.ant) rows.push(`<div class="row"><span class="lab fan">反</span>${w.ant}</div>`);
    if (w.note) rows.push(`<div class="row"><span class="lab">注</span>${w.note}</div>`);

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
      <div class="wc-detail collapsed" data-detail="${idx}">${rows.join('') || '<div class="row" style="color:#9a9aab">（无更多信息）</div>'}</div>`;

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
      if (on) setWrong(studyUnitId, w.w, false); // 学会后从错词本移除
      saveState();
      renderUnits();
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

function startTest(queue, title) {
  if (!queue.length) { toast('没有可检验的词'); return; }
  test = { queue, pos: 0, phase: 'read', origin: title, right: 0, miss: [] };
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

$('#btn-got').addEventListener('click', () => judge(true));
$('#btn-nope').addEventListener('click', () => judge(false));

function judge(remembered) {
  const item = test.queue[test.pos];
  state.stats.tested += 1;
  if (remembered) state.stats.correct += 1;

  if (remembered) {
    setWrong(item.unitId, item.word.w, false); // 从错词本移除
    test.right += 1;
  } else {
    setWrong(item.unitId, item.word.w, true);
    test.miss.push(item);
  }
  saveState();

  test.pos += 1;
  showCard();
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
function renderFavorites() {
  const box = $('#fav-list');
  if (!box) return;
  box.innerHTML = '';
  let count = 0;
  DATA.units.forEach((u) => {
    const m = state.favorites[String(u.id)] || {};
    const keys = Array.isArray(m) ? null : Object.keys(m);
    if (!keys || !keys.length) return;
    const words = keys.map((k) => u.words.find((x) => wordKey(x.w) === k)).filter(Boolean);
    words.forEach((w) => {
      count++;
      const card = document.createElement('div');
      card.className = 'word-card';
      card.innerHTML = `
        <div class="wc-head">
          <div class="wc-main">
            <div class="wc-word-row">
              <span class="wc-word">${w.w}</span>
              <span class="mini-btn" style="border:none;background:#fff3d6;color:#b8860b">${u.name}</span>
            </div>
            ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
            <div class="wc-cn">${w.defs.map((d) => `<span class="pos">${d.pos || ''}</span>${d.cn || ''}`).join('<br>')}</div>
          </div>
          <div class="wc-actions">
            <button class="speak-btn">🔊</button>
            <button class="mini-btn" data-unfav>取消收藏</button>
          </div>
        </div>`;
      card.querySelector('.speak-btn').addEventListener('click', (ev) => { ev.stopPropagation(); speak(w.w); });
      card.querySelector('[data-unfav]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        setFav(u.id, w.w, false);
        saveState(); renderFavorites();
        toast('已取消收藏');
      });
      box.appendChild(card);
    });
  });
  if (!count) box.innerHTML = '<div class="empty-tip">收藏夹是空的 ⭐<br>学习时点单词旁的「☆」把不熟的词收进来，之后在这里集中复习</div>';
}

function buildQueueFavorites() {
  const q = [];
  DATA.units.forEach((u) => {
    const m = state.favorites[String(u.id)] || {};
    const keys = Array.isArray(m) ? null : Object.keys(m);
    if (!keys) return;
    keys.forEach((k) => {
      const idx = u.words.findIndex((w) => wordKey(w.w) === k);
      if (idx >= 0) q.push({ unitId: u.id, idx, word: u.words[idx] });
    });
  });
  shuffle(q);
  return q;
}

$('#btn-test-fav').addEventListener('click', () => {
  startTest(buildQueueFavorites(), '检验收藏');
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
      card.innerHTML = `
        <div class="wc-head">
          <div class="wc-main">
            <div class="wc-word-row">
              <span class="wc-word">${w.w}</span>
              <span class="mini-btn" style="border:none;background:#fdeaea;color:#c66">${u.name}</span>
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
  Sakura.setEnabled(!!s.sakura);
}

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
      };
      if (DATA.units.length) migrateProgress();
      saveState(); applySettings(); renderUnits(); renderWrongList();
      renderTodo(); Reading.renderHome(); Reading.renderWrongVocab();
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
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  saveState(); applySettings(); renderUnits(); renderWrongList();
  renderTodo(); renderTodoRemBar();
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
    // 连续刷题天数（北京时间，今天或昨天截止）
    const days = new Set(ids.map((k) => bjDate(r.done[k].ts)));
    let streak = 0;
    const d = new Date();
    if (!days.has(bjDate())) d.setDate(d.getDate() - 1); // 今天没刷从昨天算
    for (;;) {
      if (days.has(bjDate(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
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

  function renderQuiz(it, redo) {
    $('#reading-list').classList.add('hidden');
    const box = $('#reading-quiz');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="rd-src-line">${it.src} · 约 ${it.words} 词 <button class="rd-speak" id="rd-speak">🔊 朗读</button></div>
      <div class="rd-text">${it.text.replace(/\n/g, '</p><p class="rd-p">').replace(/^/, '<p class="rd-p">') + '</p>'}</div>
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
    $('#rd-speak').addEventListener('click', () => speak(it.text.replace(/\n/g, ' ')));
    $('#rd-next').addEventListener('click', () => { start(); });
    $('#rd-back').addEventListener('click', () => { box.classList.add('hidden'); $('#reading-list').classList.remove('hidden'); renderPage(); });
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
            <button class="vw-fav ${faved ? 'on' : ''}" data-w="${v.w}" data-cn="${v.cn}" title="收藏到错词本">${faved ? '★' : '☆'}</button>
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
      if (r.vocab[w]) { delete r.vocab[w]; b.classList.remove('on'); b.textContent = '☆'; toast('已取消收藏'); }
      else { r.vocab[w] = { cn: b.dataset.cn, ts: Date.now() }; b.classList.add('on'); b.textContent = '★'; toast('已收藏到错词本·阅读生词'); }
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

  /** 错词本页的阅读生词分区 */
  function renderWrongVocab() {
    const box = $('#read-vocab-list');
    if (!box) return;
    const r = rState();
    const words = Object.keys(r.vocab);
    if (!words.length) {
      box.innerHTML = '<div class="set-note">暂无。在阅读随手练的生词环节点 ★ 收藏的词，会出现在这里。</div>';
      return;
    }
    box.innerHTML = words.map((w) => `
      <div class="rem-item"><div><div>${w}</div><div class="rem-when">${r.vocab[w].cn}</div></div>
      <button class="rem-del" data-rvw="${w}">认识</button></div>`).join('');
    box.querySelectorAll('[data-rvw]').forEach((b) => b.addEventListener('click', () => {
      delete rState().vocab[b.dataset.rvw];
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

/* ================= 提醒（Web Push） ================= */
const Reminder = (() => {
  const DEFAULT_API = 'https://vocab-flash-qf.qingfweihe.deno.net';
  let API = localStorage.getItem('sgwd_api') || (location.hostname.endsWith('deno.dev') ? '' : DEFAULT_API);
  let pingTimer = null;

  function rem() {
    if (!state.reminder) state.reminder = { id: '', enabled: false, time: '20:00', smart: true, custom: [] };
    return state.reminder;
  }

  /** 上报服务端的完整设置：必须带 todo——服务端只认 settings.todo 判定待办推送 */
  function settingsPayload() {
    const out = Object.assign({}, rem());
    out.todo = Array.isArray(state.todo) ? state.todo : [];
    return out;
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
    const res = await fetch(API + '/api/' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
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

  /** 订阅（需要用户手势内调用）*/
  async function enable() {
    if (!pushSupported()) {
      setStatus('当前浏览器不支持通知（iPhone 需 iOS 16.4+，且先添加到主屏幕）', 'err');
      return false;
    }
    if (!isStandalone()) {
      setStatus('请先把本应用「添加到主屏幕」，再从主屏图标打开后开启提醒（iPhone 的限制）', 'warn');
      return false;
    }
    try {
      setStatus('正在开启…');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setStatus('通知权限被拒绝：到 iPhone 设置 → 通知 → 闪过背单词 里允许', 'err');
        return false;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { publicKey } = await api('pubkey');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      }
      const r = await api('subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub.toJSON(), settings: settingsPayload() }),
      });
      rem().id = r.id;
      rem().enabled = true;
      saveState();
      const enEl = $('#rem-enabled');
      if (enEl) enEl.checked = true;
      setStatus('提醒已开启 ✓ 到点会推送通知', 'ok');
      sync(true);
      return true;
    } catch (e) {
      setStatus('开启失败：' + String(e).slice(0, 80) + '（若刚添加主屏，杀掉重开一次再试）', 'err');
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

  /** 把设置推给服务端（节流）*/
  let syncTimer = null;
  function sync(now) {
    if (!rem().id) return;
    clearTimeout(syncTimer);
    const doIt = () => api('settings', {
      method: 'POST',
      body: JSON.stringify({ id: rem().id, settings: settingsPayload() }),
    }).catch(() => {});
    now ? doIt() : (syncTimer = setTimeout(doIt, 1500));
  }

  /** 学习状态上报（供智能模式判断"今天是否已背过"）*/
  function ping() {
    if (!rem().id || !rem().enabled) return;
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      let learnedTotal = 0;
      for (const k in state.learned) learnedTotal += countKeys(state.learned, k);
      api('settings', {
        method: 'POST',
        body: JSON.stringify({ id: rem().id, lastActive: Date.now(), learnedTotal }),
      }).catch(() => {});
    }, 2000);
  }

  async function sendTest() {
    if (!rem().id) { setStatus('先开启提醒再发送测试', 'warn'); return; }
    setStatus('正在发送测试通知…');
    try {
      await api('test', { method: 'POST', body: JSON.stringify({ id: rem().id }) });
      setStatus('测试通知已发出，几秒内到（没收到检查系统通知设置）', 'ok');
    } catch (e) {
      setStatus('测试失败：' + String(e).slice(0, 80), 'err');
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
    const apiInput = $('#rem-api');
    if (apiInput) {
      apiInput.value = API;
      apiInput.addEventListener('change', (e) => {
        const v = e.target.value.trim().replace(/\/+$/, '');
        API = v;
        localStorage.setItem('sgwd_api', v);
        setStatus('后端地址已更新为 ' + v, 'ok');
      });
    }

    if (r.enabled && r.id) setStatus('提醒已开启 ✓ 每天 ' + (r.time || '20:00') + (r.smart !== false ? '（已背过则跳过）' : ''), 'ok');
    else if (!isStandalone()) setStatus('提示：先「添加到主屏幕」，从主屏图标打开后再开启提醒', '');
  }

  return { init, ping, sync, isStandalone, pushSupported, enable, disable, sendTest };
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

/* ================= 搜索 & 继续学习 ================= */
function renderSearch(q) {
  const box = $('#search-results');
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
  if (!hits.length) {
    box.innerHTML = '<div class="sr-empty">没有找到相关单词</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = hits.map((h) => `
    <div class="sr-item" data-unit="${h.u.id}" data-idx="${h.idx}">
      <div><span class="sr-word">${h.w.w}</span><span class="sr-unit">${h.u.name}</span></div>
      <div class="sr-cn">${(h.w.defs[0] && h.w.defs[0].cn) || ''}</div>
    </div>`).join('');
  box.classList.remove('hidden');
}

$('#search-input').addEventListener('input', (e) => renderSearch(e.target.value));
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});
$('#search-results').addEventListener('click', (e) => {
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

/* ================= 启动 ================= */
async function boot() {
  // 阶段一：轻量索引，秒开首页
  try {
    const m = await (await fetch('data/meta.json', { cache: 'no-cache' })).json();
    META = m;
    $('#topbar-sub').textContent = (m.meta && m.meta.subtitle) || '';
  } catch (e) { /* 忽略，等全量 */ }

  applySettings();
  renderUnits();
  renderContinue();
  renderWrongList();
  nav('units');
  Reminder.init();
  migrateTodo();
  bindTodo();
  renderTodoRemBar();
  Reading.bind();
  Reading.renderHome();

  // 从通知点进来：?view=todo 直达待办清单
  try {
    if (new URLSearchParams(location.search).get('view') === 'todo') nav('todo');
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
