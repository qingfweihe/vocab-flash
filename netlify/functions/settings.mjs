/**
 * POST /settings body: { id, settings }     更新提醒设置
 * POST /settings body: { id, lastActive, learnedTotal, learnedUnit? }  学习状态上报
 *   （带 lastActive 即视为 ping）
 */
import { json, preflight, subStore } from "../lib/store.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST" && req.method !== "PUT") return json({ error: "method" }, 405);
  try {
    const body = await req.json();
    const id = body.id;
    if (!id) return json({ error: "no id" }, 400);
    const store = subStore();
    const rec = await store.get(`sub:${id}`, { type: "json" });
    if (!rec) return json({ error: "not found" }, 404);

    if (body.lastActive) {
      rec.lastActive = body.lastActive;
      if (body.learnedTotal != null) rec.learnedTotal = body.learnedTotal;
      if (body.learnedUnit != null) rec.learnedUnit = body.learnedUnit;
    } else {
      rec.settings = Object.assign({}, rec.settings, body.settings || {});
    }
    await store.setJSON(`sub:${id}`, rec);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
};

export const config = { path: "/api/settings" };
