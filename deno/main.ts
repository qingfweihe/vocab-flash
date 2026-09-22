/**
 * 闪过背单词 · 推送提醒后端（Deno Deploy）
 *
 * 路由：
 *   GET  /api/pubkey            -> { publicKey }（首次访问自动生成并持久化 VAPID 密钥）
 *   POST /api/subscribe         { subscription, settings } -> { id }
 *   POST /api/settings          { id, settings } 或 { id, lastActive, learnedTotal }
 *   POST /api/test              { id }  -> 立即发送测试通知
 *   GET  /api/health            -> { ok: true }（探测用）
 *
 * 定时：Deno.cron 每 5 分钟检查（北京时间换算）；同一提醒当天幂等（不重复推送）。
 */
import webpush from "npm:web-push@3.6.7";

const kv = await Deno.openKv();
const TZ = 8 * 3600 * 1000; // 北京时间 UTC+8

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

type VapidKeys = { publicKey: string; privateKey: string };

async function getVapid(): Promise<VapidKeys> {
  const rec = await kv.get<VapidKeys>(["vapid"]);
  let kp = rec.value;
  if (!kp) {
    kp = webpush.generateVAPIDKeys() as VapidKeys;
    await kv.set(["vapid"], kp);
  }
  webpush.setVapidDetails("mailto:reminder@vocab-flash.app", kp.publicKey, kp.privateKey);
  return kp;
}

async function subIdOf(endpoint: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

type SubRecord = {
  subscription: unknown;
  settings: Record<string, unknown>;
  lastActive?: number;
  learnedTotal?: number;
};

// ---------- 时间工具（北京时间） ----------
const localNow = () => new Date(Date.now() + TZ);
const localDateStr = (d: Date) => d.toISOString().slice(0, 10);
function minutesOf(hhmm: string): number {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function inWindow(targetHm: string, now: Date): boolean {
  if (!targetHm) return false;
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  let d = cur - minutesOf(targetHm);
  if (d < 0) d += 1440;
  return d >= 0 && d < 5;
}

function isPushSub(x: unknown): x is { endpoint: string } {
  return !!x && typeof x === "object" && typeof (x as { endpoint?: string }).endpoint === "string";
}

// ---------- HTTP ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (url.pathname === "/api/health") return json({ ok: true });

    if (url.pathname === "/api/pubkey") {
      const kp = await getVapid();
      return json({ publicKey: kp.publicKey });
    }

    if (url.pathname === "/api/subscribe" && req.method === "POST") {
      const body = await req.json();
      const sub = body.subscription;
      if (!isPushSub(sub)) return json({ error: "no subscription" }, 400);
      const id = await subIdOf(sub.endpoint);
      await kv.set(["sub", id], {
        subscription: sub,
        settings: body.settings || {},
      } satisfies SubRecord);
      return json({ ok: true, id });
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const body = await req.json();
      if (!body.id) return json({ error: "no id" }, 400);
      const key = ["sub", String(body.id)];
      const rec = (await kv.get<SubRecord>(key)).value;
      if (!rec) return json({ error: "not found" }, 404);
      if (body.lastActive) {
        rec.lastActive = body.lastActive;
        if (body.learnedTotal != null) rec.learnedTotal = body.learnedTotal;
      } else {
        rec.settings = Object.assign({}, rec.settings, body.settings || {});
      }
      await kv.set(key, rec);
      return json({ ok: true });
    }

    if (url.pathname === "/api/test" && req.method === "POST") {
      const body = await req.json();
      const rec = (await kv.get<SubRecord>(["sub", String(body.id || "")])).value;
      if (!rec) return json({ error: "not found" }, 404);
      await getVapid();
      await webpush.sendNotification(
        rec.subscription as Parameters<typeof webpush.sendNotification>[0],
        JSON.stringify({ title: "🌸 测试通知", body: "提醒功能已就绪，之后到点会像这样提醒你", tag: "test" }),
      );
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 500);
  }
});

// ---------- 定时检查（每 5 分钟） ----------
Deno.cron("reminder-check", "*/5 * * * *", async () => {
  const now = localNow();
  const today = localDateStr(now);
  const kp = await kv.get<VapidKeys>(["vapid"]);
  if (!kp.value) return; // 还没有任何订阅
  await getVapid();

  for await (const entry of kv.list<SubRecord>({ prefix: ["sub"] })) {
    const id = String(entry.key[1]);
    const rec = entry.value;
    if (!isPushSub(rec.subscription)) continue;
    const st = rec.settings || {};
    if (st.enabled === false) continue;
    const payloads: Array<{ title: string; body: string; tag: string }> = [];

    // 自定义事项（到点发一次）
    const custom = Array.isArray(st.custom)
      ? (st.custom as Array<{ id?: string; text?: string; when?: string }>).filter((x) => x && x.when)
      : [];
    const fired: string[] = [];
    for (const item of custom) {
      const [dpart, tpart] = String(item.when).split("T");
      if (dpart === today && inWindow(tpart, now)) {
        const key = `sent:${id}:c:${item.id ?? dpart + tpart}`;
        const dup = await kv.get([key]);
        if (!dup.value) {
          payloads.push({ title: "⏰ 提醒", body: String(item.text ?? ""), tag: "custom-" + (item.id ?? "") });
          await kv.set([key], true, { expireIn: 86400_000 * 2 });
          fired.push(String(item.id ?? ""));
        }
      }
    }
    if (fired.length) {
      st.custom = custom.filter((x) => !fired.includes(String(x.id ?? "")));
      rec.settings = st;
      await kv.set(["sub", id], rec);
    }

    // 每日背单词提醒（智能模式：今天已学则跳过；当天幂等）
    if (st.time && inWindow(String(st.time), now)) {
      const activeToday = rec.lastActive && localDateStr(new Date(rec.lastActive + TZ)) === today;
      const smart = st.smart !== false;
      if (!(smart && activeToday)) {
        const sentKey = ["sent", id, today];
        const dup = await kv.get(sentKey);
        if (!dup.value) {
          const total = rec.learnedTotal != null ? `已学 ${rec.learnedTotal} 词` : "今天也该刷一组了";
          payloads.push({ title: "🌸 该背单词了", body: `${total} · 点开闪过背单词继续`, tag: "daily" });
          await kv.set(sentKey, true, { expireIn: 86400_000 * 2 });
        }
      }
    }

    for (const p of payloads) {
      try {
        await webpush.sendNotification(
          rec.subscription as Parameters<typeof webpush.sendNotification>[0],
          JSON.stringify(p),
        );
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await kv.delete(["sub", id]); // 订阅失效
      }
    }
  }
});
