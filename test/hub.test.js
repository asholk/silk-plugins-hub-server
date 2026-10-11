import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { parseChangelog } from "../src/changelog.js";
import { storeRelease } from "../src/releases.js";
import { compareVersions, signToken } from "../src/util.js";
import { setAdminPassword } from "../src/admin/auth.js";
import { issueTokens } from "../src/auth.js";
import { addMember, upsertUser } from "../src/data.js";

test("parseChangelog reads the Changelog block with typed items", () => {
  const msg =
    "feat: pdf export\n\nChangelog:\n- Новое: экспорт в PDF — чтобы делиться заметками\n- Исправлено: сортировка тегов\n- просто пункт\n\n- вне блока";
  assert.deepEqual(parseChangelog(msg), [
    { type: "new", text: "экспорт в PDF", why: "чтобы делиться заметками" },
    { type: "fixed", text: "сортировка тегов", why: "" },
    { type: "other", text: "просто пункт", why: "" },
  ]);
});

test("compareVersions orders semver", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

function release(version, extra = "", id = "test-plugin") {
  return {
    tag: version,
    notes: `Changelog:\n- Новое: функция ${version}`,
    files: {
      "main.js": Buffer.from(`module.exports = class {}; // ${version} ${extra}`),
      "manifest.json": Buffer.from(JSON.stringify({ id, name: "Test", version, minAppVersion: "1.5.0" })),
    },
  };
}

async function setup(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  const config = loadConfig({ SESSION_SECRET: "x".repeat(40), DATA_DIR: dataDir, ...env });
  const { app, ctx } = await buildApp(config, { logger: false });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, ctx, config, store: ctx.store };
}

const pathOf = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

test("plugin flow: sign in, list plugins, check updates, download, revoke", async (t) => {
  const { app, ctx, store } = await setup(t, { DEV_LOGIN: "1" });

  await store.put("companies", { id: 1, slug: "acme", name: "ACME", email_domains: "acme.ru" });
  await store.put("plugins", { id: "test-plugin", name: "Test", description: "", instructions: "" });
  await store.put("company_plugins", { company_id: 1, plugin_id: "test-plugin", required: false });
  await storeRelease(ctx, "test-plugin", release("1.0.0"));

  // PKCE sign-in through the dev login.
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const start = await app.inject({ url: `/auth/start?state=abc&challenge=${challenge}` });
  assert.equal(start.statusCode, 302);
  const serverState = new URL(start.headers.location, "http://x").searchParams.get("state");
  const login = await app.inject({ method: "POST", url: "/auth/dev", payload: { state: serverState, email: "user@acme.ru" } });
  assert.equal(login.statusCode, 200);
  const code = login.body.match(/silk-hub-auth\?code=([^&"]+)&amp;state=abc/)?.[1];
  assert.ok(code, "callback link with code");

  const bad = await app.inject({ method: "POST", url: "/auth/token", payload: { code, verifier: "wrong" } });
  assert.equal(bad.statusCode, 400);

  // The code was consumed by the failed attempt; sign in again.
  const start2 = await app.inject({ url: `/auth/start?state=abc&challenge=${challenge}` });
  const state2 = new URL(start2.headers.location, "http://x").searchParams.get("state");
  const login2 = await app.inject({ method: "POST", url: "/auth/dev", payload: { state: state2, email: "user@acme.ru" } });
  const code2 = login2.body.match(/silk-hub-auth\?code=([^&"]+)&amp;/)[1];
  const tokens = (await app.inject({ method: "POST", url: "/auth/token", payload: { code: code2, verifier } })).json();
  assert.ok(tokens.accessToken && tokens.refreshToken);
  const auth = { authorization: `Bearer ${tokens.accessToken}` };

  // Auto-assigned to ACME by email domain.
  const me = (await app.inject({ url: "/api/me", headers: auth })).json();
  assert.deepEqual(me.companies.map((c) => c.slug), ["acme"]);

  // Company by code: case-insensitive; unknown codes and foreign companies look the same.
  const lookup = (c) => app.inject({ url: `/api/companies/lookup?code=${encodeURIComponent(c)}`, headers: auth });
  assert.equal((await lookup(" ACME ")).json().company.slug, "acme");
  assert.equal((await lookup("nope")).statusCode, 404);

  const list = (await app.inject({ url: "/api/companies/1/plugins?appVersion=1.12.0", headers: auth })).json();
  assert.equal(list.plugins[0].latest.version, "1.0.0");

  const check = async (installed) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/updates/check",
        headers: auth,
        payload: { companyIds: [1], selected: ["test-plugin", "gone"], installed, appVersion: "1.12.0" },
      })
    ).json();

  let res = await check({});
  assert.equal(res.updates[0].reason, "install");
  assert.deepEqual(res.removed, ["gone"]);
  // Download links are signed and short-lived; they work without the Bearer token.
  const asset = res.updates[0].assets.find((a) => a.name === "main.js");
  const file = await app.inject({ url: pathOf(asset.url) });
  assert.equal(file.statusCode, 200);
  assert.equal(crypto.createHash("sha256").update(file.rawPayload).digest("hex"), asset.sha256);
  assert.equal((await app.inject({ url: pathOf(asset.url).replace(/t=[^&]+/, "t=bad") })).statusCode, 403);

  await storeRelease(ctx, "test-plugin", release("1.1.0"));
  await storeRelease(ctx, "test-plugin", release("1.2.0"));
  res = await check({ "test-plugin": "1.0.0" });
  assert.equal(res.updates[0].version, "1.2.0");
  assert.deepEqual(res.updates[0].changelog.map((c) => c.version), ["1.2.0", "1.1.0"]);

  assert.equal((await check({ "test-plugin": "1.2.0" })).updates.length, 0);

  // Revoking the installed version offers the previous one as a rollback.
  const r12 = await store.get("releases", { plugin_id: "test-plugin", version: "1.2.0" });
  await store.put("releases", { ...r12, revoked: true });
  res = await check({ "test-plugin": "1.2.0" });
  assert.equal(res.updates[0].reason, "revoked");
  assert.equal(res.updates[0].version, "1.1.0");

  // Several companies: plugins are merged, required if any company requires it.
  await store.put("companies", { id: 2, slug: "beta", name: "Beta", email_domains: "" });
  await store.put("plugins", { id: "beta-plugin", name: "Beta plugin", description: "", instructions: "" });
  await store.put("company_plugins", { company_id: 2, plugin_id: "test-plugin", required: true });
  await store.put("company_plugins", { company_id: 2, plugin_id: "beta-plugin", required: false });
  await storeRelease(ctx, "beta-plugin", release("1.0.0", "", "beta-plugin"));
  assert.equal((await app.inject({ url: "/api/catalog?companies=1,2", headers: auth })).statusCode, 403);
  await addMember(store, me.user.id, 2);
  const merged = (await app.inject({ url: "/api/catalog?companies=1,2", headers: auth })).json().plugins;
  assert.deepEqual(merged.map((p) => [p.id, p.required, p.companies]), [["beta-plugin", false, [2]], ["test-plugin", true, [1, 2]]]);
  const both = (
    await app.inject({ method: "POST", url: "/api/updates/check", headers: auth, payload: { companyIds: [1, 2], selected: ["beta-plugin"], installed: {} } })
  ).json();
  assert.deepEqual(both.updates.map((u) => u.id).sort(), ["beta-plugin", "test-plugin"]);
  assert.deepEqual(both.removed, []);

  // Non-members cannot read the company.
  for (const m of await store.list("memberships")) await store.delete("memberships", m);
  assert.equal((await app.inject({ url: "/api/companies/1/plugins", headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/me" })).statusCode, 401);

  // Refresh tokens rotate.
  const refreshed = (await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: tokens.refreshToken } })).json();
  assert.ok(refreshed.accessToken);
  const reused = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: tokens.refreshToken } });
  assert.equal(reused.statusCode, 401);
});

test("download links are limited per user per hour", async (t) => {
  const { app, ctx, store } = await setup(t, { DOWNLOADS_PER_HOUR: "4" });
  await store.put("companies", { id: 1, slug: "acme", name: "ACME", email_domains: "" });
  await store.put("plugins", { id: "test-plugin", name: "Test", description: "", instructions: "" });
  await store.put("company_plugins", { company_id: 1, plugin_id: "test-plugin", required: true });
  await storeRelease(ctx, "test-plugin", release("1.0.0"));
  const user = await upsertUser(store, { email: "u@x.ru" });
  await addMember(store, user.id, 1);
  const auth = { authorization: `Bearer ${(await issueTokens(ctx, user.id)).accessToken}` };
  const check = () => app.inject({ method: "POST", url: "/api/updates/check", headers: auth, payload: { companyIds: [1], selected: [], installed: {} } });
  assert.equal((await check()).statusCode, 200); // 2 files
  assert.equal((await check()).statusCode, 200); // 4 files
  assert.equal((await check()).statusCode, 429);
});

test("requests per IP are limited in memory", async (t) => {
  const { app } = await setup(t, { REQUESTS_PER_MINUTE: "3" });
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/health" })).statusCode, 429);
});

/** Signs in as an admin and returns a JSON caller for /admin-api. */
async function adminApi(app, store) {
  await setAdminPassword(store, "boss", "correct-horse-battery");
  const login = await app.inject({ method: "POST", url: "/admin-api/login", payload: { username: "boss", password: "correct-horse-battery" } });
  const headers = { authorization: `Bearer ${login.json().token}` };
  return (method, url, payload) => app.inject({ method, url, headers, payload });
}

test("CI publishes a release with a publish token", async (t) => {
  const { app, store } = await setup(t);
  const admin = await adminApi(app, store);
  await admin("POST", "/admin-api/plugins", { id: "test-plugin", name: "Test" });

  const issued = await admin("POST", "/admin-api/plugins/test-plugin/token");
  const { token } = issued.json();
  assert.match(token, /^hubp_/);
  const stored = await store.get("plugins", { id: "test-plugin" });
  assert.ok(stored.publish_token_hash && !JSON.stringify(stored).includes(token), "only the hash is stored");

  const rel = release("2.0.0");
  rel.files["card.md"] = Buffer.from("# Card\n\n![shot](shot.png)");
  rel.files["shot.png"] = Buffer.from("89504e470d0a1a0a", "hex");
  const list = Object.entries(rel.files).map(([name, buf]) => ({
    name,
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  }));
  const bearer = (tk) => ({ authorization: `Bearer ${tk}` });

  assert.equal((await app.inject({ method: "POST", url: "/publish/test-plugin/start", headers: bearer("hubp_wrong"), payload: { version: "2.0.0", files: list } })).statusCode, 401);
  const bad = await app.inject({ method: "POST", url: "/publish/test-plugin/start", headers: bearer(token), payload: { version: "2.0.0", files: [{ name: "evil.exe", size: 1, sha256: "0".repeat(64) }] } });
  assert.equal(bad.statusCode, 400);

  const start = (await app.inject({ method: "POST", url: "/publish/test-plugin/start", headers: bearer(token), payload: { version: "2.0.0", files: list } })).json();
  for (const u of start.uploads) {
    const put = await app.inject({ method: "PUT", url: pathOf(u.url), payload: rel.files[u.name], headers: { "content-type": "application/octet-stream" } });
    assert.equal(put.statusCode, 200, u.name);
  }
  // A tampered list fails the hash check.
  const tampered = list.map((f) => (f.name === "main.js" ? { ...f, sha256: "f".repeat(64) } : f));
  const fail = await app.inject({ method: "POST", url: "/publish/test-plugin/commit", headers: bearer(token), payload: { version: "2.0.0", nonce: start.nonce, files: tampered } });
  assert.equal(fail.statusCode, 400);

  const done = await app.inject({
    method: "POST",
    url: "/publish/test-plugin/commit",
    headers: bearer(token),
    payload: { version: "2.0.0", nonce: start.nonce, notes: "Changelog:\n- Новое: публикация из CI — без ручной синхронизации", files: list },
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json().installable, ["main.js", "manifest.json"]);
  const saved = await store.get("releases", { plugin_id: "test-plugin", version: "2.0.0" });
  assert.equal(saved.changes[0].why, "без ручной синхронизации");
  assert.ok(saved.card.includes("![shot](shot.png)"));

  const again = await app.inject({ method: "POST", url: "/publish/test-plugin/start", headers: bearer(token), payload: { version: "2.0.0", files: list } });
  assert.equal(again.statusCode, 409);
});

test("admin signs in with login and password, with lockout after failures", async (t) => {
  const { app, store } = await setup(t);
  await setAdminPassword(store, "boss", "correct-horse-battery");

  assert.equal((await app.inject({ url: "/admin-api/companies" })).statusCode, 401);
  const wrong = await app.inject({ method: "POST", url: "/admin-api/login", payload: { username: "boss", password: "nope" } });
  assert.equal(wrong.statusCode, 401);

  const ok = await app.inject({ method: "POST", url: "/admin-api/login", payload: { username: "boss", password: "correct-horse-battery" } });
  assert.equal(ok.statusCode, 200);
  const headers = { authorization: `Bearer ${ok.json().token}` };
  const create = await app.inject({ method: "POST", url: "/admin-api/companies", headers, payload: { name: "ACME", slug: "acme", emailDomains: "@acme.ru" } });
  assert.equal(create.statusCode, 200, create.body);
  assert.equal((await store.list("companies"))[0].email_domains, "acme.ru");
  const taken = await app.inject({ method: "POST", url: "/admin-api/companies", headers, payload: { name: "Other", slug: "acme" } });
  assert.equal(taken.statusCode, 409);

  // Signing out invalidates the token.
  await app.inject({ method: "POST", url: "/admin-api/logout", headers });
  assert.equal((await app.inject({ url: "/admin-api/companies", headers })).statusCode, 401);

  for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/admin-api/login", payload: { username: "boss", password: "bad" } });
  const locked = await app.inject({ method: "POST", url: "/admin-api/login", payload: { username: "boss", password: "correct-horse-battery" } });
  assert.equal(locked.statusCode, 429);
});

test("Hub user tokens and stale admin tokens don't open the admin API", async (t) => {
  const { app, ctx, config, store } = await setup(t);
  await setAdminPassword(store, "boss", "correct-horse-battery");
  const stale = signToken({ aid: 1, typ: "admin", exp: Math.floor(Date.now() / 1000) + 60 }, config.sessionSecret);
  assert.equal((await app.inject({ url: "/admin-api/me", headers: { authorization: `Bearer ${stale}` } })).statusCode, 401);
  const user = await upsertUser(store, { email: "u@acme.ru" });
  const access = (await issueTokens(ctx, user.id)).accessToken;
  assert.equal((await app.inject({ url: "/admin-api/me", headers: { authorization: `Bearer ${access}` } })).statusCode, 401);
});

test("the admin API can be limited to allowed IPs", async (t) => {
  const { app } = await setup(t, { ADMIN_ALLOWED_IPS: "10.0.0.1" });
  const login = { method: "POST", url: "/admin-api/login", payload: { username: "x", password: "y" } };
  assert.equal((await app.inject(login)).statusCode, 404);
  assert.equal((await app.inject({ ...login, remoteAddress: "10.0.0.1" })).statusCode, 401);
});

test("admin creates a company with plugins, sets access per plugin and sees the card", async (t) => {
  const { app, ctx, store } = await setup(t, { DEV_LOGIN: "1" });
  const admin = await adminApi(app, store);

  await admin("POST", "/admin-api/plugins", { id: "test-plugin", name: "Test", repo: "aoph/test", instructions: "Откройте палитру команд" });
  await admin("POST", "/admin-api/plugins", { id: "other-plugin", name: "Other" });
  const created = await admin("POST", "/admin-api/companies", { name: "ACME", slug: "acme", plugins: [{ id: "test-plugin" }, { id: "other-plugin" }] });
  assert.equal(created.statusCode, 200);
  assert.deepEqual((await store.list("company_plugins")).map((r) => r.plugin_id).sort(), ["other-plugin", "test-plugin"]);

  // Access from the plugin side: make test-plugin required, remove other-plugin.
  await admin("PUT", "/admin-api/plugins/test-plugin/companies", { companies: [{ id: 1, required: true }] });
  await admin("PUT", "/admin-api/plugins/other-plugin/companies", { companies: [] });
  assert.deepEqual((await store.list("company_plugins")).map((r) => [r.plugin_id, r.required]), [["test-plugin", true]]);
  const list = (await admin("GET", "/admin-api/companies")).json();
  assert.deepEqual(list.companies[0].plugins, [{ id: "test-plugin", required: true }]);

  // Members by email, also from the user side.
  const member = (await admin("POST", "/admin-api/companies/1/members", { email: "new@acme.ru" })).json();
  assert.equal((await admin("GET", "/admin-api/companies/1")).json().members[0].email, "new@acme.ru");
  await admin("PUT", `/admin-api/users/${member.id}/companies`, { companyIds: [] });
  assert.equal((await admin("GET", "/admin-api/companies/1")).json().members.length, 0);

  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const rel = release("1.0.0");
  rel.files["card.md"] = Buffer.from("# Test\n\n![Экран](screen.png)\n\n<script>alert(1)</script>\n");
  rel.files["screen.png"] = png;
  rel.files["guide.md"] = Buffer.from(["# Инструкция", "", "## Функция", "", "![Шаг](screen.png)", ""].join("\n"));
  await storeRelease(ctx, "test-plugin", rel);

  const detail = (await admin("GET", "/admin-api/plugins/test-plugin")).json();
  assert.equal(detail.plugin.name, "Test");
  assert.equal(detail.releases[0].version, "1.0.0");
  const imgUrl = detail.card.markdown.match(/\((http:\/\/localhost:8787\/files\/[^)]+)\)/)[1];
  const img = await app.inject({ url: pathOf(imgUrl) });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/png");
  assert.match(detail.guide.markdown, /## Функция/);

  // Revoke and restore.
  await admin("POST", "/admin-api/plugins/test-plugin/releases/1.0.0/revoke");
  assert.equal((await store.get("releases", { plugin_id: "test-plugin", version: "1.0.0" })).revoked, true);
  await admin("POST", "/admin-api/plugins/test-plugin/releases/1.0.0/restore");

  // A Hub user of ACME sees instructions, the card flag and the card itself; card files aren't installed.
  const user = await upsertUser(store, { email: "u@acme.ru" });
  await addMember(store, user.id, 1);
  const auth = { authorization: `Bearer ${(await issueTokens(ctx, user.id)).accessToken}` };
  const catalog = (await app.inject({ url: "/api/companies/1/plugins", headers: auth })).json();
  assert.equal(catalog.plugins[0].instructions, "Откройте палитру команд");
  assert.equal(catalog.plugins[0].hasCard, true);
  const card = (await app.inject({ url: "/api/plugins/test-plugin/card", headers: auth })).json();
  assert.match(card.markdown, /!\[Экран\]\(http:\/\/localhost:8787\/files\/plugins\/test-plugin\/1\.0\.0\/screen\.png\?t=/);
  assert.equal(catalog.plugins[0].hasGuide, true);
  const guide = (await app.inject({ url: "/api/plugins/test-plugin/guide", headers: auth })).json();
  assert.match(guide.markdown, /## Функция/);
  assert.equal((await app.inject({ url: "/api/plugins/test-plugin/other", headers: auth })).statusCode, 404);
  const check = (await app.inject({ method: "POST", url: "/api/updates/check", headers: auth, payload: { companyIds: [1], selected: [], installed: {} } })).json();
  assert.deepEqual(check.updates[0].assets.map((a) => a.name), ["main.js", "manifest.json"]);

  await admin("DELETE", "/admin-api/companies/1");
  assert.equal((await store.list("companies")).length, 0);
  assert.equal((await store.list("company_plugins")).length, 0);
});
