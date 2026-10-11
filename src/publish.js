import crypto from "node:crypto";
import { withinLimit } from "./data.js";
import { ASSET_NAMES, isReleaseFile, MAX_FILES, maxSize, storeRelease } from "./releases.js";
import { isValidPluginId, isValidVersion, randomToken, sha256Hex } from "./util.js";

/**
 * Publishing from CI (or `npm run publish` in a plugin repository), with a per-plugin publish token:
 *   1. POST /publish/<id>/start  { version, files: [{ name, size, sha256 }] } → one-time upload links
 *   2. PUT each file to its link (straight to storage, so size isn't limited by the function)
 *   3. POST /publish/<id>/commit { version, nonce, notes, files } → the Hub checks hashes and the manifest
 * Files are uploaded to a staging folder and copied on commit, so links can't overwrite a published version.
 */

/** A new publish token: shown to the admin once, only its hash is stored. */
export function newPublishToken() {
  const token = `hubp_${randomToken(32)}`;
  return { token, hash: sha256Hex(token) };
}

const stagingKey = (pluginId, version, nonce, name) => `staging/${pluginId}/${version}/${nonce}/${name}`;
const UPLOAD_TTL = 15 * 60;

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function checkFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return "files: 1–40 items expected";
  const names = new Set();
  for (const f of files) {
    if (!f || !isReleaseFile(f.name) || names.has(f.name)) return `unexpected file ${f?.name}`;
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > maxSize(f.name)) return `${f.name}: bad size`;
    if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) return `${f.name}: sha256 expected`;
    names.add(f.name);
  }
  if (!names.has("main.js") || !names.has("manifest.json")) return "main.js and manifest.json are required";
  return null;
}

export function registerPublishRoutes(app, ctx) {
  const { store, files } = ctx;

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/publish/")) return;
    const pluginId = req.url.split("/")[2];
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const plugin = isValidPluginId(pluginId) ? await store.get("plugins", { id: pluginId }) : null;
    if (!plugin?.publish_token_hash || !token || !sameHash(sha256Hex(token), plugin.publish_token_hash)) {
      return reply.code(401).send({ error: "invalid publish token" });
    }
    if (!(await withinLimit(store, `publish:${pluginId}`, 60, 3600))) return reply.code(429).send({ error: "too many publishes" });
    req.plugin = plugin;
  });

  app.post("/publish/:id/start", async (req, reply) => {
    const { version, files: list } = req.body ?? {};
    if (!isValidVersion(version)) return reply.code(400).send({ error: "invalid version" });
    const problem = checkFiles(list);
    if (problem) return reply.code(400).send({ error: problem });
    if (await store.get("releases", { plugin_id: req.plugin.id, version })) {
      return reply.code(409).send({ error: "version already published" });
    }
    const nonce = randomToken(12);
    const uploads = [];
    for (const f of list) {
      uploads.push({ name: f.name, url: await files.uploadUrl(stagingKey(req.plugin.id, version, nonce, f.name), UPLOAD_TTL) });
    }
    return { nonce, uploads };
  });

  app.post("/publish/:id/commit", async (req, reply) => {
    const { version, nonce, notes, files: list } = req.body ?? {};
    if (!isValidVersion(version) || !/^[A-Za-z0-9_-]{16}$/.test(String(nonce))) return reply.code(400).send({ error: "invalid request" });
    const problem = checkFiles(list);
    if (problem) return reply.code(400).send({ error: problem });
    const buffers = {};
    for (const f of list) {
      const buf = await files.get(stagingKey(req.plugin.id, version, nonce, f.name));
      if (!buf) return reply.code(400).send({ error: `${f.name} was not uploaded` });
      if (buf.length !== f.size || sha256Hex(buf) !== f.sha256) return reply.code(400).send({ error: `${f.name}: checksum mismatch` });
      buffers[f.name] = buf;
    }
    const manifest = JSON.parse(buffers["manifest.json"].toString("utf8"));
    if (manifest.version !== version) return reply.code(400).send({ error: `manifest.json has version ${manifest.version}` });
    try {
      const release = await storeRelease(ctx, req.plugin.id, { tag: version, notes: String(notes ?? ""), files: buffers });
      if (!release) return reply.code(409).send({ error: "version already published" });
      req.log.info(`published ${req.plugin.id} ${version}`);
      return {
        plugin: req.plugin.id,
        version,
        files: release.assets.map((a) => a.name),
        installable: release.assets.filter((a) => ASSET_NAMES.includes(a.name)).map((a) => a.name),
        changes: release.changes.length,
      };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
