/**
 * 定时函数（每 5 分钟）：检查所有订阅的提醒时刻并推送。
 * - 每日背单词提醒：settings.time（如 "20:00"，北京时间）+ 智能模式（今天已学则不打扰）
 * - 自定义事项：settings.custom = [{id, text, when:"2026-09-22T20:30"}]，到点推送后移除
 */
import { getVapid, json, send, subStore } from "../lib/store.mjs";

const TZ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间 UTC+8

function localNow() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}
function hm(date) {
  return String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0");
}
function localDateStr(date) {
  return date.toISOString().slice(0, 10); // 以 UTC 字段表示北京日期
}
function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 目标时刻是否落在 [now, now+5) 分钟窗口 */
function inWindow(targetHm, nowDate) {
  if (!targetHm) return false;
  const cur = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
  let d = cur - minutesOf(targetHm);
  if (d < 0) d += 1440;
  return d >= 0 && d < 5;
}

export default async () => {
  const now = localNow();
  const today = localDateStr(now);
  const store = subStore();
  const { blobs } = await store.list();
  await getVapid();

  const results = [];
  for (const b of blobs || []) {
    if (!b.key.startsWith("sub:")) continue;
    const rec = await store.get(b.key, { type: "json" });
    if (!rec || !rec.subscription) continue;
    const st = rec.settings || {};
    const payloads = [];

    // 自定义事项（有无条件都检查，不受每日开关影响；enabled 关闭则全部不发）
    if (st.enabled !== false) {
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
        const learnedToday = rec.lastActive && localDateStr(new Date(rec.lastActive + TZ_OFFSET_MS)) === today;
        if (!(st.smart !== false && learnedToday)) {
          const total = rec.learnedTotal != null ? `已学 ${rec.learnedTotal} 词` : "今天也该刷一组了";
          payloads.push({ title: "🌸 该背单词了", body: `${total} · 点开闪过背单词继续`, tag: "daily" });
        }
      }
    }

    for (const p of payloads) {
      try {
        await send(rec.subscription, p);
        results.push({ id: b.key, sent: p.tag });
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) {
          await store.delete(b.key); // 订阅已失效
          results.push({ id: b.key, removed: true });
        } else {
          results.push({ id: b.key, error: String(e).slice(0, 120) });
        }
      }
    }
  }
  return json({ ok: true, ranAt: now.toISOString(), results });
};

export const config = { schedule: "*/5 * * * *" };
