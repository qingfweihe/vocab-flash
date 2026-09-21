/**
 * POST /subscribe  body: { subscription, settings }
 *   subscription: PushSubscription JSON
 *   settings: { enabled, time:"20:00", smart:true, unit:"" }
 * 以 endpoint 的哈希作为订阅 id 存储。
 */
import crypto from "node:crypto";
import { json, preflight, subStore } from "../lib/store.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const body = await req.json();
    const sub = body.subscription;
    if (!sub || !sub.endpoint) return json({ error: "no subscription" }, 400);
    const id = crypto.createHash("sha1").update(sub.endpoint).digest("hex").slice(0, 16);
    const store = subStore();
    await store.setJSON(`sub:${id}`, { subscription: sub, settings: body.settings || {} });
    return json({ ok: true, id });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
};

export const config = { path: "/api/subscribe" };
