// Copies the SQLite store to <backups>/store-<date>.db and keeps the newest 14 copies.
//   node scripts/backup.js <backups dir>
// Safe while the server runs: VACUUM INTO writes a consistent snapshot. Release files are
// immutable once published, so they are copied only when missing.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KEEP = 14;
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const target = path.resolve(process.argv[2] ?? "./backups");
fs.mkdirSync(target, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const file = path.join(target, `store-${stamp}.db`);
fs.rmSync(file, { force: true });
const db = new DatabaseSync(path.join(dataDir, "store.db"), { readOnly: true });
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();

const snapshots = fs.readdirSync(target).filter((n) => /^store-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort();
for (const old of snapshots.slice(0, -KEEP)) fs.rmSync(path.join(target, old));

const files = path.join(dataDir, "files");
if (fs.existsSync(files)) fs.cpSync(files, path.join(target, "files"), { recursive: true, force: false, errorOnExist: false });
console.log(`Backed up ${file}; ${Math.min(snapshots.length, KEEP)} snapshots kept.`);
