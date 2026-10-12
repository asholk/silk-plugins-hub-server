import fs from "node:fs";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { nowSec, signToken, verifyToken } from "./util.js";

/**
 * Plugin files, cards and screenshots. Clients never get the storage itself: they get short-lived signed
 * links for one file, issued only to members of a company that has the plugin.
 */

const safeKey = (key) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) || key.includes("..")) throw new Error(`bad file key ${key}`);
  return key;
};

/** Local folder; links point to this server and are signed with the session secret. For development and tests. */
export function localFiles({ dataDir, baseUrl, secret }) {
  const root = path.join(dataDir, "files");
  const file = (key) => path.join(root, safeKey(key));
  const link = (route, key, ttl, extra = {}) =>
    `${baseUrl}/${route}/${key}?t=${encodeURIComponent(signToken({ k: key, typ: route, exp: nowSec() + ttl, ...extra }, secret))}`;
  return {
    kind: "local",
    async put(key, buf) {
      fs.mkdirSync(path.dirname(file(key)), { recursive: true });
      fs.writeFileSync(file(key), buf);
    },
    async get(key) {
      return fs.existsSync(file(key)) ? fs.readFileSync(file(key)) : null;
    },
    async delete(key) {
      fs.rmSync(file(key), { force: true });
    },
    async url(key, ttl) {
      return link("files", key, ttl);
    },
    async uploadUrl(key, ttl) {
      return link("files-upload", key, ttl);
    },
    /** Routes that serve and accept the signed links. */
    register(app) {
      app.get("/files/*", async (req, reply) => {
        const key = req.params["*"];
        const p = verifyToken(String(req.query.t ?? ""), secret);
        if (!p || p.typ !== "files" || p.k !== key) return reply.code(403).send({ error: "forbidden" });
        const buf = await this.get(key);
        if (!buf) return reply.code(404).send({ error: "not found" });
        return reply.type(contentType(key)).header("Cache-Control", "private, max-age=3600").send(buf);
      });
      app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 }, (req, body, done) =>
        done(null, body),
      );
      app.put("/files-upload/*", async (req, reply) => {
        const key = req.params["*"];
        const p = verifyToken(String(req.query.t ?? ""), secret);
        if (!p || p.typ !== "files-upload" || p.k !== key) return reply.code(403).send({ error: "forbidden" });
        await this.put(key, Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? ""));
        return { ok: true };
      });
    },
  };
}

/** Yandex Object Storage (S3 API) with presigned links; the bucket stays private. */
export function s3Files({ bucket, accessKeyId, secretAccessKey, endpoint = "https://storage.yandexcloud.net", region = "ru-central1" }) {
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
  const objectUrl = (key) => `${endpoint}/${bucket}/${safeKey(key).split("/").map(encodeURIComponent).join("/")}`;
  const presign = async (key, method, ttl) => {
    const url = new URL(objectUrl(key));
    url.searchParams.set("X-Amz-Expires", String(ttl));
    const signed = await aws.sign(url.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  };
  return {
    kind: "s3",
    async put(key, buf) {
      const res = await aws.fetch(objectUrl(key), { method: "PUT", body: buf, headers: { "Content-Type": contentType(key) } });
      if (!res.ok) throw new Error(`storage PUT ${key}: ${res.status} ${await res.text()}`);
    },
    async get(key) {
      const res = await aws.fetch(objectUrl(key));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage GET ${key}: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await aws.fetch(objectUrl(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`storage DELETE ${key}: ${res.status}`);
    },
    url: (key, ttl) => presign(key, "GET", ttl),
    uploadUrl: (key, ttl) => presign(key, "PUT", ttl),
    register() {},
  };
}

const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  js: "application/javascript",
  json: "application/json",
  css: "text/css",
  md: "text/markdown; charset=utf-8",
};
export const contentType = (key) => TYPES[key.split(".").pop().toLowerCase()] ?? "application/octet-stream";
