import crypto from "node:crypto";

export const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const sha256B64Url = (data) => crypto.createHash("sha256").update(data).digest("base64url");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Compact signed token: base64url(json).base64url(hmac). */
export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp === "number" && payload.exp < nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Compares x.y.z[-pre] versions. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = String(v).trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

export const isValidVersion = (v) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(v));
export const isValidPluginId = (id) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(String(id));
