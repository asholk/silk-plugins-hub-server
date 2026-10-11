import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { loadConfig } from "./config.js";
import { sqliteStore } from "./store/sqlite.js";
import { localFiles, s3Files } from "./files.js";
import { registerAuthRoutes } from "./auth.js";
import { registerApiRoutes } from "./api.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerPublishRoutes } from "./publish.js";

export async function openStore(config, { tokenProvider } = {}) {
  if (config.store.kind === "ydb") {
    const { ydbStore } = await import("./store/ydb.js");
    return ydbStore({ connectionString: config.store.ydbConnectionString, prefix: config.store.ydbPrefix, tokenProvider });
  }
  return sqliteStore(config.dataDir);
}

export function openFiles(config) {
  if (config.files.kind === "s3") return s3Files(config.files);
  return localFiles({ dataDir: config.dataDir, baseUrl: config.baseUrl, secret: config.sessionSecret });
}

/**
 * Requests per IP per minute, in this instance's memory. Cheap first line against floods: rejected
 * requests don't touch the database or storage.
 */
function ipLimiter(limit) {
  const hits = new Map();
  let window = 0;
  return (ip) => {
    const now = Math.floor(Date.now() / 60000);
    if (now !== window) {
      hits.clear();
      window = now;
    }
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    return n <= limit;
  };
}

export async function buildApp(config = loadConfig(), { logger = true, store, tokenProvider } = {}) {
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 });
  const ctx = {
    store: store ?? (await openStore(config, { tokenProvider })),
    files: openFiles(config),
    config,
    log: app.log,
  };

  await app.register(formbody);

  const allow = ipLimiter(config.limits.requestsPerMinute);
  app.addHook("onRequest", async (req, reply) => {
    if (!allow(req.ip)) return reply.code(429).header("Retry-After", "60").send({ error: "too many requests" });
    if (req.url.startsWith("/admin-api/") || req.url.startsWith("/auth/") || req.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/", async () => ({ service: "Silk Plugins Hub" }));
  ctx.files.register(app);
  registerAuthRoutes(app, ctx);
  registerApiRoutes(app, ctx);
  registerPublishRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  app.addHook("onClose", async () => ctx.store.close());
  return { app, ctx };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const { app } = await buildApp(config);
  await app.listen({ port: config.port, host: config.host });
}
