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
 * 待办清单（settings.todo）：[{ id, text, type:'once'|'daily'|'weekly', date?, time, wd?, done?, todayDone? }]
 *   once   -> date+time 到点推一次（错过 12h 内补推，超过视为过期不再推）
 *   daily  -> 每天 time 到点推（当天幂等；todayDone=当天日期 则今天跳过）
 *   weekly -> wd(0-6, 周日=0) 那天 time 到点推
 * 旧版 settings.custom（一次性）兼容读取。
 *
 * 定时：Deno.cron 每 5 分钟检查（北京时间换算）。
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

// ---------- 待办清单 ----------
type TodoItem = {
  id: string;
  text: string;
  type: "once" | "daily" | "weekly";
  date?: string; // once: YYYY-MM-DD（北京时间）
  time: string;  // HH:MM
  wd?: number;   // weekly: 0-6（周日=0）
  done?: boolean;      // once：完成不再推
  todayDone?: string;  // daily/weekly：勾"今天不再提醒"
};
type Payload = { title: string; body: string; tag: string; url: string };

const TODO_URL = "./?view=todo";
const CATCHUP_MS = 12 * 3600 * 1000; // 错过补发窗口

/** 计算一条待办"计划触发时刻"（北京时间毫秒）；null=今天不适用 */
function plannedAt(item: TodoItem, now: Date, today: string): number | null {
  const m = minutesOf(item.time);
  const dayStart = (day: string) => new Date(`${day}T00:00:00Z`).getTime() - TZ; // 北京当天零点的 UTC 毫秒
  if (item.type === "once") {
    if (!item.date) return null;
    return dayStart(item.date) + m * 60_000;
  }
  if (item.type === "daily") {
    return dayStart(today) + m * 60_000;
  }
  if (item.type === "weekly") {
    if (item.wd == null || item.wd !== now.getUTCDay()) return null;
    return dayStart(today) + m * 60_000;
  }
  return null;
}

/** 收集该订阅当前应推送的待办，返回 (payload, 幂等键) 列表 */
async function dueTodos(id: string, st: Record<string, unknown>, now: Date, today: string): Promise<Array<[Payload, string]>> {
  const out: Array<[Payload, string]> = [];
  let items: TodoItem[] = Array.isArray(st.todo) ? (st.todo as TodoItem[]) : [];
  // 旧版 custom（一次性 when）兼容：转成 todo 项参与判断
  if (!items.length && Array.isArray(st.custom)) {
    items = (st.custom as Array<{ id?: string; text?: string; when?: string }>)
      .filter((x) => x && x.when)
      .map((x, i) => {
        const [d, t] = String(x.when).split("T");
        return { id: String(x.id ?? "c" + i), text: String(x.text ?? ""), type: "once" as const, date: d, time: t || "09:00" };
      });
  }
  for (const item of items) {
    if (!item || !item.text || !item.time) continue;
    if (item.type === "once" && item.done) continue;
    if (item.todayDone === today) continue; // 用户勾了"今天不再提醒"
    const plan = plannedAt(item, now, today);
    if (plan == null) continue;
    const late = Date.now() - plan;
    if (late < 0 || late > CATCHUP_MS) continue; // 还没到 / 过期超过 12h
    const key = ["sent", id, item.id, item.type === "once" ? `${item.date}T${item.time}` : `${today}T${item.time}`];
    const dup = await kv.get(key);
    if (dup.value) continue;
    const whenTxt = item.type === "once"
      ? `${(item.date || "").slice(5)} ${item.time}`
      : item.type === "weekly" ? `每周${"日一二三四五六"[item.wd ?? 0]} ${item.time}`
      : `每天 ${item.time}`;
    out.push([
      { title: "⏰ 待办提醒", body: `${item.text}（${whenTxt}）`, tag: "todo-" + item.id, url: TODO_URL },
      JSON.stringify(key),
    ]);
  }
  return out;
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
        const inc = body.settings || {};
        // 客户端已升级为待办清单（带 todo 字段）时，旧 custom 作废，防止清空待办后旧事项复活
        if (Object.prototype.hasOwnProperty.call(inc, "todo")) delete rec.settings.custom;
        rec.settings = Object.assign({}, rec.settings, inc);
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
        JSON.stringify({ title: "🌸 测试通知", body: "提醒功能已就绪，之后到点会像这样提醒你", tag: "test", url: TODO_URL }),
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
    const payloads: Payload[] = [];

    // 待办清单（含旧版 custom 兼容）
    for (const [p, keyStr] of await dueTodos(id, st, now, today)) {
      payloads.push(p);
      await kv.set(JSON.parse(keyStr) as Deno.KvKey, true, { expireIn: 86400_000 * 2 });
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
          payloads.push({ title: "🌸 该背单词了", body: `${total} · 点开闪过背单词继续`, tag: "daily", url: "./" });
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
