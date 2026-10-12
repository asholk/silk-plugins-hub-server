import fs from "node:fs";
import path from "node:path";
import { parseChangelog } from "./changelog.js";
import { isValidVersion, sha256Hex } from "./util.js";

/** Files Obsidian loads; only these are installed into the vault. */
export const ASSET_NAMES = ["main.js", "manifest.json", "styles.css"];
/** Plugin card: Markdown overview with screenshots, from hub/card.md in the plugin repository. */
export const CARD_NAME = "card.md";
/** Detailed instructions per feature with screenshots, from hub/guide.md. */
export const GUIDE_NAME = "guide.md";
const DOC_NAMES = [CARD_NAME, GUIDE_NAME];
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(png|jpe?g|gif|webp)$/i;
export const MAX_ASSET = 20 * 1024 * 1024;
export const MAX_DOC_FILE = 5 * 1024 * 1024;
export const MAX_FILES = 40;

export const isCardImage = (name) => IMAGE_RE.test(name);
export const isReleaseFile = (name) => ASSET_NAMES.includes(name) || DOC_NAMES.includes(name) || isCardImage(name);
export const maxSize = (name) => (ASSET_NAMES.includes(name) ? MAX_ASSET : MAX_DOC_FILE);
export const fileKey = (pluginId, version, name) => `plugins/${pluginId}/${version}/${name}`;

/**
 * Validates a release and saves it: files to storage under plugins/<id>/<version>/, metadata, card, guide
 * and changelog to the store. With `uploaded` the files are already in storage (published by CI).
 * Returns the release, or null if this version already exists.
 */
export async function storeRelease(ctx, pluginId, { tag, notes, publishedAt, files, uploaded = false }) {
  if (!files["main.js"] || !files["manifest.json"]) throw new Error("release must contain main.js and manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(files["manifest.json"].toString("utf8"));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (manifest.id !== pluginId) throw new Error(`manifest id "${manifest.id}" does not match plugin "${pluginId}"`);
  if (!isValidVersion(manifest.version)) throw new Error(`invalid version "${manifest.version}"`);
  if (await ctx.store.get("releases", { plugin_id: pluginId, version: manifest.version })) return null;

  const assets = [];
  for (const [name, buf] of Object.entries(files)) {
    if (!isReleaseFile(name)) continue;
    if (buf.length > maxSize(name)) throw new Error(`${name} is too large`);
    const key = fileKey(pluginId, manifest.version, name);
    if (!uploaded) await ctx.files.put(key, buf);
    assets.push({ name, sha256: sha256Hex(buf), size: buf.length, key });
  }
  const release = {
    plugin_id: pluginId,
    version: manifest.version,
    min_app_version: manifest.minAppVersion ?? "0.0.0",
    desktop_only: manifest.isDesktopOnly === true,
    tag: tag ?? manifest.version,
    notes: notes ?? "",
    card: files[CARD_NAME] ? files[CARD_NAME].toString("utf8") : "",
    guide: files[GUIDE_NAME] ? files[GUIDE_NAME].toString("utf8") : "",
    published_at: publishedAt ?? new Date().toISOString(),
    revoked: false,
    assets: assets.sort((a, b) => a.name.localeCompare(b.name)),
    changes: parseChangelog(notes),
  };
  await ctx.store.put("releases", release);
  return release;
}

/**
 * Fills desktop_only for releases stored before the flag existed, from their manifest.json.
 * Runs once at startup; a release whose manifest can't be read stays unmarked.
 */
export async function backfillDesktopOnly(ctx) {
  for (const release of await ctx.store.list("releases")) {
    if (release.desktop_only !== undefined) continue;
    const asset = release.assets.find((a) => a.name === "manifest.json");
    try {
      const buf = asset ? await ctx.files.get(asset.key) : null;
      if (!buf) continue;
      await ctx.store.put("releases", { ...release, desktop_only: JSON.parse(buf.toString("utf8")).isDesktopOnly === true });
    } catch (err) {
      ctx.log.warn({ err, plugin: release.plugin_id, version: release.version }, "cannot read release manifest");
    }
  }
}

/** Reads a release folder from disk: plugin files from the root, card, guide and screenshots from hub/. */
export function readReleaseDir(dir) {
  const files = {};
  for (const name of ASSET_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) files[name] = fs.readFileSync(file);
  }
  const hubDir = path.join(dir, "hub");
  if (fs.existsSync(hubDir)) {
    for (const name of fs.readdirSync(hubDir)) {
      if (DOC_NAMES.includes(name) || isCardImage(name)) files[name] = fs.readFileSync(path.join(hubDir, name));
    }
  }
  return files;
}
