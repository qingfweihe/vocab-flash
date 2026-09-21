/** POST /test body:{id} -> 立即向该订阅发一条测试通知 */
import { getVapid, json, preflight, send, subStore } from "../lib/store.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const { id } = await req.json();
    if (!id) return json({ error: "no id" }, 400);
    const store = subStore();
    const rec = await store.get(`sub:${id}`, { type: "json" });
    if (!rec) return json({ error: "not found" }, 404);
    await getVapid();
    await send(rec.subscription, {
      title: "🌸 测试通知",
      body: "提醒功能已就绪，之后到点会像这样提醒你",
      tag: "test",
    });
    return json({ ok: true });
  } catch (e) {
    const msg = String(e).slice(0, 200);
    return json({ error: msg }, e && e.statusCode === 410 ? 410 : 500);
  }
};

export const config = { path: "/api/test" };
