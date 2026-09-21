/**
 * 共享工具：Netlify Blobs 存储封装 + VAPID 密钥自管理
 */
import { getStore } from "@netlify/blobs";
import webpush from "web-push";

const SETTINGS_KEY = "vapid";

/** 获取（或首次生成并持久化）VAPID 密钥对 */
export async function getVapid() {
  const store = getStore("vocab-reminder");
  let kp = await store.get(SETTINGS_KEY, { type: "json" });
  if (!kp) {
    kp = webpush.generateVAPIDKeys(); // { publicKey, privateKey }
    await store.setJSON(SETTINGS_KEY, kp);
  }
  webpush.setVapidDetails("mailto:reminder@vocab-flash.local", kp.publicKey, kp.privateKey);
  return kp;
}

export function subStore() {
  return getStore("vocab-subs");
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function send(sub, payload) {
  return webpush.sendNotification(sub, JSON.stringify(payload));
}
