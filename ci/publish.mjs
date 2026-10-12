// Publishes the built plugin to Silk Hub: main.js, manifest.json, styles.css and the hub/ docs
// (card.md, guide.md, screenshots). Release notes are the commit's "Changelog:" block.
//
//   HUB_URL=https://… HUB_PUBLISH_TOKEN=hubp_… node ci/publish.mjs [--notes notes.txt]
//
// Copy it into the plugin repository (for example as scripts/publish.mjs) and run it in CI after `npm run build`.
// Does nothing if this version is already published.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const hubUrl = (process.env.HUB_URL ?? "").replace(/\/$/, "");
const token = process.env.HUB_PUBLISH_TOKEN ?? "";
if (!hubUrl || !token) {
  console.error("HUB_URL and HUB_PUBLISH_TOKEN are required (CI secrets or .hub.env).");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const { id, version } = manifest;

const files = [];
for (const name of ["main.js", "manifest.json", "styles.css"]) if (fs.existsSync(name)) files.push([name, name]);
if (fs.existsSync("hub")) {
  for (const name of fs.readdirSync("hub")) {
    if (name === "card.md" || name === "guide.md" || /\.(png|jpe?g|gif|webp)$/i.test(name)) files.push([name, path.join("hub", name)]);
  }
}
if (!files.some(([n]) => n === "main.js")) {
  console.error("main.js not found: run `npm run build` first.");
  process.exit(1);
}

function notes() {
  const i = process.argv.indexOf("--notes");
  if (i > 0) return fs.readFileSync(process.argv[i + 1], "utf8");
  if (process.env.SOURCECRAFT_COMMIT_MESSAGE) return process.env.SOURCECRAFT_COMMIT_MESSAGE;
  try {
    return execFileSync("git", ["log", "-1", "--format=%B"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

const list = files.map(([name, file]) => {
  const buf = fs.readFileSync(file);
  return { name, file, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
});
const meta = list.map(({ name, size, sha256 }) => ({ name, size, sha256 }));

async function call(step, body) {
  const res = await fetch(`${hubUrl}/publish/${encodeURIComponent(id)}/${step}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const start = await call("start", { version, files: meta });
if (start.status === 409) {
  console.log(`${id} ${version} is already published, nothing to do.`);
  process.exit(0);
}
if (start.status !== 200) {
  console.error(`Publish failed (${start.status}): ${start.data.error ?? "unknown error"}`);
  process.exit(1);
}

for (const u of start.data.uploads) {
  const f = list.find((x) => x.name === u.name);
  const res = await fetch(u.url, { method: "PUT", body: fs.readFileSync(f.file), headers: { "Content-Type": "application/octet-stream" } });
  if (!res.ok) {
    console.error(`Upload of ${u.name} failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`  uploaded ${u.name} (${f.size} bytes)`);
}

const done = await call("commit", { version, nonce: start.data.nonce, notes: notes(), files: meta });
if (done.status !== 200) {
  console.error(`Publish failed (${done.status}): ${done.data.error ?? "unknown error"}`);
  process.exit(1);
}
console.log(`Published ${id} ${version} to ${hubUrl}: ${done.data.files.join(", ")}; changelog items: ${done.data.changes}.`);
