import path from "node:path";

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 8787);
  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set (at least 32 characters)");
  }
  const list = (v) => String(v ?? "").split(/[\s,]+/).filter(Boolean);
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    baseUrl,
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    sessionSecret,
    devLogin: env.DEV_LOGIN === "1",
    // Behind API Gateway the client IP comes from the gateway event, not from X-Forwarded-For.
    trustProxy: env.TRUST_PROXY !== "0",
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    },
    // "sqlite" (local) or "ydb" (Yandex Cloud).
    store: {
      kind: env.STORE ?? "sqlite",
      ydbConnectionString: env.YDB_CONNECTION_STRING ?? "",
      ydbPrefix: env.YDB_TABLE_PREFIX ?? "hub_",
    },
    // "local" (data/files) or "s3" (Yandex Object Storage).
    files: {
      kind: env.FILES ?? "local",
      bucket: env.S3_BUCKET ?? "",
      accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    },
    limits: {
      // Signed download links per user per hour: one install takes up to 3.
      downloadsPerHour: Number(env.DOWNLOADS_PER_HOUR ?? 300),
      // Requests per IP per minute, counted in each instance's memory.
      requestsPerMinute: Number(env.REQUESTS_PER_MINUTE ?? 300),
      // Sign-in starts and token exchanges per IP per 10 minutes.
      authPer10Min: Number(env.AUTH_PER_10_MIN ?? 30),
    },
    // Optional: the admin panel opens only from these IPs.
    adminAllowedIps: list(env.ADMIN_ALLOWED_IPS),
    accessTokenTtlSec: 60 * 60,
    refreshTokenTtlSec: 90 * 24 * 60 * 60,
    fileLinkTtlSec: 15 * 60,
    cardLinkTtlSec: 24 * 3600,
  };
}
