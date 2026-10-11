// Moves data from the old relational SQLite database (data/hub.db + data/assets) into the store and file
// storage configured in .env (for example YDB and Object Storage):
//   npm run migrate -- [path/to/hub.db]
// Admins, companies, users, memberships, plugins, access and releases with their files are copied.
// Sign-in sessions are not: users sign in again.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { openFiles, openStore } from "../src/server.js";
import { fileKey } from "../src/releases.js";

const config = loadConfig();
const oldPath = path.resolve(process.argv[2] ?? path.join(config.dataDir, "hub.db"));
if (!fs.existsSync(oldPath)) {
  console.error(`No old database at ${oldPath}`);
  process.exit(1);
}
const old = new DatabaseSync(oldPath, { readOnly: true });
const oldDir = path.dirname(oldPath);
const store = await openStore(config);
const files = openFiles(config);
const all = (sql, ...p) => old.prepare(sql).all(...p);
const max = { users: 0, companies: 0 };

for (const a of all("SELECT username, password_hash FROM admins")) await store.put("admins", { ...a });
for (const c of all("SELECT * FROM companies")) {
  await store.put("companies", { id: c.id, slug: c.slug, name: c.name, email_domains: c.email_domains });
  max.companies = Math.max(max.companies, c.id);
}
for (const u of all("SELECT * FROM users")) {
  await store.put("users", { id: u.id, email: u.email, name: u.name, google_sub: u.google_sub, created_at: u.created_at });
  max.users = Math.max(max.users, u.id);
}
for (const m of all("SELECT * FROM memberships")) await store.put("memberships", { user_id: m.user_id, company_id: m.company_id });
for (const p of all("SELECT * FROM plugins")) {
  await store.put("plugins", {
    id: p.id,
    name: p.name,
    description: p.description,
    instructions: p.instructions ?? "",
    repo: p.sc_org && p.sc_repo ? `${p.sc_org}/${p.sc_repo}` : "",
    publish_token_hash: null,
  });
}
for (const l of all("SELECT * FROM company_plugins")) {
  await store.put("company_plugins", { company_id: l.company_id, plugin_id: l.plugin_id, required: !!l.required });
}
let fileCount = 0;
for (const r of all("SELECT * FROM releases")) {
  const assets = [];
  for (const a of all("SELECT * FROM assets WHERE release_id = ? ORDER BY name", r.id)) {
    const key = fileKey(r.plugin_id, r.version, a.name);
    await files.put(key, fs.readFileSync(path.join(oldDir, a.path)));
    assets.push({ name: a.name, sha256: a.sha256, size: a.size, key });
    fileCount++;
  }
  const changes = all("SELECT type, text, why FROM changelog_items WHERE release_id = ? ORDER BY id", r.id).map((i) => ({ ...i }));
  await store.put("releases", {
    plugin_id: r.plugin_id,
    version: r.version,
    min_app_version: r.min_app_version,
    tag: r.tag,
    notes: r.notes,
    card: r.card ?? "",
    guide: r.guide ?? "",
    published_at: r.published_at,
    revoked: !!r.revoked,
    assets,
    changes,
  });
}
// Ids of new users and companies continue after the copied ones.
for (const [name, value] of Object.entries(max)) await store.put("counters", { name, value });

console.log(
  `Migrated: ${all("SELECT COUNT(*) n FROM companies")[0].n} companies, ${all("SELECT COUNT(*) n FROM users")[0].n} users, ` +
    `${all("SELECT COUNT(*) n FROM plugins")[0].n} plugins, ${all("SELECT COUNT(*) n FROM releases")[0].n} releases, ${fileCount} files.`,
);
await store.close();
process.exit(0);
