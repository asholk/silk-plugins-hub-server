import crypto from "node:crypto";
import { nowSec, signToken, verifyToken } from "../util.js";

const SESSION_TTL = 7 * 24 * 3600;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

/** scrypt hash in the form scrypt$<salt>$<hash>, both base64url. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Creates the admin or replaces their password. A new password also ends the admin's sessions. */
export async function setAdminPassword(store, username, password) {
  if (String(password).length < 10) throw new Error("password must be at least 10 characters");
  const existing = await store.get("admins", { username });
  await store.put("admins", { username, password_hash: hashPassword(password), session_version: (existing?.session_version ?? 0) + 1 });
}

/**
 * Admin from `Authorization: Bearer <admin token>`. The token carries the admin's session version,
 * so signing out (or a new password) invalidates every token issued before.
 */
export async function adminFromRequest(ctx, request) {
  const header = request.headers.authorization ?? "";
  const payload = verifyToken(header.startsWith("Bearer ") ? header.slice(7) : "", ctx.config.sessionSecret);
  if (!payload || payload.typ !== "admin" || typeof payload.adm !== "string") return null;
  const admin = await ctx.store.get("admins", { username: payload.adm });
  if (!admin || (admin.session_version ?? 0) !== payload.ver) return null;
  return admin;
}

export function registerAdminAuthRoutes(app, ctx) {
  const { store, config } = ctx;

  app.post("/admin-api/login", async (req, reply) => {
    // Failed attempts per IP are kept in the store: serverless instances don't share memory.
    const entry = await store.get("login_failures", { ip: req.ip });
    if (entry && entry.count >= MAX_FAILURES && Date.now() - entry.at < LOCK_MS) {
      return reply.code(429).send({ error: "too many attempts, try again in 15 minutes" });
    }
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const admin = username ? await store.get("admins", { username }) : null;
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      const count = entry && Date.now() - entry.at < LOCK_MS ? entry.count + 1 : 1;
      await store.put("login_failures", { ip: req.ip, count, at: Date.now() });
      return reply.code(401).send({ error: "wrong login or password" });
    }
    if (entry) await store.delete("login_failures", { ip: req.ip });
    const token = signToken(
      { adm: admin.username, typ: "admin", ver: admin.session_version ?? 0, exp: nowSec() + SESSION_TTL },
      config.sessionSecret,
    );
    return { token, username: admin.username, expiresIn: SESSION_TTL };
  });

  app.post("/admin-api/logout", async (req) => {
    const admin = await adminFromRequest(ctx, req);
    if (admin) await store.put("admins", { ...admin, session_version: (admin.session_version ?? 0) + 1 });
    return { ok: true };
  });
}
