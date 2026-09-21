/**
 * GET /cron-notify?key=XXX —— 定时推送检查（由 GitHub Actions 每 5 分钟调用）
 * 也可以用 Netlify 自身 scheduled 触发（下方 config.schedule 已保留）。
 * - 每日背单词提醒：settings.time（北京时间）+ 智能模式（今天已学则跳过）
 * - 自定义事项：settings.custom = [{id, text, when:"2026-09-22T20:30"}]
 */
import { getVapid, json, send, subStore } from "../lib/store.mjs";

const TZ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间 UTC+8
const CRON_KEY = "vf-reminder-9f3k2";  // 与 .github/workflows/reminder-cron.yml 一致

function localNow() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}
function localDateStr(date) {
  return date.toISOString().slice(0, 10);
}
function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function inWindow(targetHm, nowDate) {
  if (!targetHm) return false;
  const cur = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
  let d = cur - minutesOf(targetHm);
  if (d < 0) d += 1440;
  return d >= 0 && d < 5;
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== CRON_KEY) return json({ error: "forbidden" }, 403);

  const now = localNow();
  const today = localDateStr(now);
  const store = subStore();
  const { blobs } = await store.list();
  await getVapid();

  const sent = [];
  for (const b of blobs || []) {
    if (!b.key.startsWith("sub:")) continue;
    const rec = await store.get(b.key, { type: "json" });
    if (!rec || !rec.subscription) continue;
    const st = rec.settings || {};
    if (st.enabled === false) continue;
    const payloads = [];

    // 自定义事项（一次性）
    const custom = Array.isArray(st.custom) ? st.custom.filter((x) => x && x.when && !x.sent) : [];
    const fired = [];
    for (const item of custom) {
      const [dpart, tpart] = String(item.when).split("T");
      if (dpart === today && inWindow(tpart, now)) {
        payloads.push({ title: "⏰ 提醒", body: item.text, tag: "custom-" + (item.id || dpart + tpart) });
        fired.push(item.id);
      }
    }
    if (fired.length) {
      st.custom = custom.filter((x) => !fired.includes(x.id));
      rec.settings = st;
      await store.setJSON(b.key, rec);
    }

    // 每日背单词提醒
    if (st.time && inWindow(st.time, now)) {
      const activeToday = rec.lastActive && localDateStr(new Date(rec.lastActive + TZ_OFFSET_MS)) === today;
      if (!(st.smart !== false && activeToday)) {
        const total = rec.learnedTotal != null ? `已学 ${rec.learnedTotal} 词` : "今天也该刷一组了";
        payloads.push({ title: "🌸 该背单词了", body: `${total} · 点开闪过背单词继续`, tag: "daily" });
      }
    }

    for (const p of payloads) {
      try {
        await send(rec.subscription, p);
        sent.push(p.tag);
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) await store.delete(b.key);
      }
    }
  }
  return json({ ok: true, ranAt: now.toISOString(), timeBeijing: url.searchParams.get("k") || "", sent });
};

// 若托管商支持 scheduled functions，也可用此自带定时（GitHub Actions 触发是主力）
export const config = { path: "/api/cron-notify" };
