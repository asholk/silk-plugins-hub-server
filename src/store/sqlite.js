import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { keyOf, matches, splitWhere, TABLES } from "./schema.js";

/** Document store on SQLite: for local development and tests. */
export function sqliteStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "store.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  for (const [table, keys] of Object.entries(TABLES)) {
    const cols = keys.map((k) => `"${k}" TEXT NOT NULL`).join(", ");
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${cols}, doc TEXT NOT NULL, PRIMARY KEY (${keys.map((k) => `"${k}"`).join(", ")}))`);
  }
  const cond = (cols) => (cols.length ? `WHERE ${cols.map((k) => `"${k}" = ?`).join(" AND ")}` : "");

  return {
    kind: "sqlite",
    async get(table, key) {
      const keys = TABLES[table];
      const row = db.prepare(`SELECT doc FROM "${table}" ${cond(keys)}`).get(...keyOf(table, key));
      return row ? JSON.parse(row.doc) : null;
    },
    async list(table, where = {}) {
      const { byKey, rest } = splitWhere(table, where);
      const cols = Object.keys(byKey);
      const rows = db.prepare(`SELECT doc FROM "${table}" ${cond(cols)}`).all(...cols.map((k) => String(byKey[k])));
      return rows.map((r) => JSON.parse(r.doc)).filter((r) => matches(r, rest));
    },
    async put(table, row) {
      const keys = TABLES[table];
      db.prepare(
        `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}, doc) VALUES (${keys.map(() => "?").join(", ")}, ?)
         ON CONFLICT DO UPDATE SET doc = excluded.doc`,
      ).run(...keyOf(table, row), JSON.stringify(row));
      return row;
    },
    async delete(table, key) {
      db.prepare(`DELETE FROM "${table}" ${cond(TABLES[table])}`).run(...keyOf(table, key));
    },
    async nextId(name) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare(`SELECT doc FROM counters WHERE name = ?`).get(name);
        const value = (row ? JSON.parse(row.doc).value : 0) + 1;
        db.prepare(`INSERT INTO counters (name, doc) VALUES (?, ?) ON CONFLICT DO UPDATE SET doc = excluded.doc`).run(
          name,
          JSON.stringify({ name, value }),
        );
        db.exec("COMMIT");
        return value;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async close() {
      db.close();
    },
  };
}
