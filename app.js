/* 闪过背单词 — 单机 PWA 逻辑
 * 数据: data/words.json  (units[].words[])
 * 进度: localStorage 'sgwd_progress_v1'
 */
'use strict';

/* ================= 状态 ================= */
const LS_KEY = 'sgwd_progress_v1';
const DEFAULT_STATE = {
  learned: {},   // unitId(str) -> [wordIdx...] 已标记掌握
  wrong: {},     // unitId(str) -> [wordIdx...] 错词
  stats: { tested: 0, correct: 0 },
  settings: { rate: 0.9, fontSize: 17, sakura: true },
};

let DATA = { meta: {}, units: [] };
let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const s = JSON.parse(raw);
    return {
      learned: s.learned || {},
      wrong: s.wrong || {},
      stats: s.stats || { tested: 0, correct: 0 },
      settings: Object.assign({}, DEFAULT_STATE.settings, s.settings || {}),
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
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
function learnedSet(id) { return new Set(state.learned[String(id)] || []); }
function wrongSet(id) { return new Set(state.wrong[String(id)] || []); }

function toggleInArray(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1); else arr.push(v);
  return arr;
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
const TAB_VIEWS = ['units', 'wrong', 'settings'];

function nav(view) {
  currentView = view;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (el) el.classList.remove('hidden');
  $$('#tabbar .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === view);
  });
  if (TAB_VIEWS.includes(view)) window.scrollTo({ top: 0 });
  if (view === 'wrong') renderWrongList();
}

document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) { nav(navBtn.dataset.nav); }
});

/* ================= 渲染：单元列表 & 总进度 ================= */
function renderUnits() {
  const box = $('#unit-list');
  box.innerHTML = '';
  let totalWords = 0, totalLearned = 0, totalWrong = 0;

  DATA.units.forEach((u) => {
    const n = u.words.length;
    const l = (state.learned[String(u.id)] || []).length;
    const w = (state.wrong[String(u.id)] || []).length;
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
}

/* ================= 学习页 ================= */
let studyUnitId = null;

function openStudy(id) {
  studyUnitId = id;
  const u = unitById(id);
  $('#study-title').textContent = `${u.name} · ${u.words.length} 词`;
  renderWordList();
  nav('study');
  window.scrollTo({ top: 0 });
}

function renderWordList() {
  const u = unitById(studyUnitId);
  const box = $('#word-list');
  const learned = learnedSet(studyUnitId);
  const wrong = wrongSet(studyUnitId);
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
            <span class="wc-word">${w.w}${wrong.has(idx) ? ' <span style="color:#d84c4c;font-size:.7em">错词</span>' : ''}</span>
            ${w.freq ? `<span class="wc-freq">${w.freq}</span>` : ''}
          </div>
          ${w.ph ? `<div class="wc-phon">[${w.ph}]</div>` : ''}
          <div class="wc-cn${hideCn ? ' hide-cn' : ''}">${defsHtml}</div>
        </div>
        <div class="wc-actions">
          <button class="speak-btn" data-speak="${idx}">🔊</button>
          <label class="wc-learn" title="标记已学"><input type="checkbox" data-learn="${idx}" ${learned.has(idx) ? 'checked' : ''}></label>
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
      const arr = state.learned[String(studyUnitId)] || (state.learned[String(studyUnitId)] = []);
      toggleInArray(arr, idx);
      if (arr.includes(idx)) { // 学会后从错词本移除
        const wa = state.wrong[String(studyUnitId)] || [];
        const wi = wa.indexOf(idx);
        if (wi >= 0) { wa.splice(wi, 1); state.wrong[String(studyUnitId)] = wa; }
      }
      saveState();
      renderUnits();
    });

    box.appendChild(card);
  });

  if (!u.words.length) box.innerHTML = '<div class="empty-tip">本单元暂无词条数据</div>';
}

$('#chk-hide-cn').addEventListener('change', () => renderWordList());

$('#btn-mark-all').addEventListener('click', () => {
  const u = unitById(studyUnitId);
  const all = u.words.map((_, i) => i);
  const cur = state.learned[String(studyUnitId)] || [];
  if (cur.length === all.length) {
    state.learned[String(studyUnitId)] = [];
    toast('已取消全部标记');
  } else {
    state.learned[String(studyUnitId)] = all;
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
    (state.wrong[String(u.id)] || []).forEach((idx) => {
      if (u.words[idx]) q.push({ unitId: u.id, idx, word: u.words[idx] });
    });
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

  const wid = String(item.unitId);
  const wa = state.wrong[wid] || (state.wrong[wid] = []);
  if (remembered) {
    const i = wa.indexOf(item.idx);
    if (i >= 0) wa.splice(i, 1); // 从错词本移除
    test.right += 1;
  } else {
    if (!wa.includes(item.idx)) wa.push(item.idx);
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

/* ================= 错词本 ================= */
function renderWrongList() {
  const box = $('#wrong-list');
  box.innerHTML = '';
  let count = 0;
  DATA.units.forEach((u) => {
    const idxs = (state.wrong[String(u.id)] || []).slice().sort((a, b) => a - b);
    if (!idxs.length) return;
    idxs.forEach((idx) => {
      const w = u.words[idx];
      if (!w) return;
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
        const arr = state.wrong[String(u.id)];
        const i = arr.indexOf(idx);
        if (i >= 0) arr.splice(i, 1);
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
        stats: s.stats || { tested: 0, correct: 0 },
        settings: Object.assign({}, DEFAULT_STATE.settings, s.settings || {}),
      };
      saveState(); applySettings(); renderUnits(); renderWrongList();
      toast('进度已恢复');
    } catch (err) { toast('文件格式不对'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

$('#btn-reset').addEventListener('click', () => {
  if (!confirm('确定清空全部学习进度？此操作不可恢复。')) return;
  state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  saveState(); applySettings(); renderUnits(); renderWrongList();
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

/* ================= Service Worker（https 环境下离线可用；http 下静默跳过） ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* ================= 启动 ================= */
async function boot() {
  try {
    const res = await fetch('data/words.json', { cache: 'no-cache' });
    DATA = await res.json();
  } catch (e) {
    $('#unit-list').innerHTML = '<div class="empty-tip">数据加载失败，请通过 http/https 访问本页面</div>';
    return;
  }
  $('#topbar-sub').textContent = DATA.meta.subtitle || '';
  applySettings();
  renderUnits();
  renderWrongList();
  nav('units');
}
boot();
