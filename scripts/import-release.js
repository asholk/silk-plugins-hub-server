// Imports a release from a local plugin folder (built main.js, manifest.json, styles.css and hub/ docs
// with screenshots) straight into the store and file storage from .env:
//   npm run import-release -- <plugin-folder> [release notes file]
// Plugin repositories normally publish through CI (scripts/publish.mjs); this is for maintenance.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openFiles, openStore } from "../src/server.js";
import { readReleaseDir, storeRelease } from "../src/releases.js";

const [dir, notesFile] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: npm run import-release -- <plugin-folder> [release-notes-file]");
  process.exit(1);
}
const config = loadConfig();
const ctx = { config, store: await openStore(config), files: openFiles(config) };
const files = readReleaseDir(path.resolve(dir));
const manifest = JSON.parse(files["manifest.json"]);
if (!(await ctx.store.get("plugins", { id: manifest.id }))) {
  console.error(`Plugin ${manifest.id} is not registered in Hub. Add it in the admin panel first.`);
  process.exit(1);
}
const notes = notesFile ? fs.readFileSync(notesFile, "utf8") : "";
const release = await storeRelease(ctx, manifest.id, { tag: manifest.version, notes, files });
console.log(
  release
    ? `Imported ${manifest.id} ${manifest.version} (${release.assets.map((a) => a.name).join(", ")})`
    : `${manifest.id} ${manifest.version} already exists`,
);
await ctx.store.close();
process.exit(0);
