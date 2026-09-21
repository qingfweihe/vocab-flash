/** GET /pubkey -> { publicKey }（首次调用自动生成并持久化 VAPID 密钥） */
import { getVapid, json, preflight } from "../lib/store.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  const kp = await getVapid();
  return json({ publicKey: kp.publicKey });
};

export const config = { path: "/api/pubkey" };
