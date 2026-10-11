/**
 * Tables of the Hub as documents with a primary key. Small data (companies, plugins, users), so joins and
 * filters run in JS; the same layout works on SQLite (local, tests) and YDB (cloud).
 */
export const TABLES = {
  admins: ["username"],
  login_failures: ["ip"],
  users: ["id"],
  companies: ["id"],
  memberships: ["user_id", "company_id"],
  plugins: ["id"],
  company_plugins: ["company_id", "plugin_id"],
  /** One row per version: metadata, card, guide, changelog items and file list. */
  releases: ["plugin_id", "version"],
  oauth_states: ["state"],
  auth_codes: ["code_hash"],
  refresh_tokens: ["token_hash"],
  counters: ["name"],
  /** Rate limit and download quota windows. */
  rate: ["key"],
};

export function keyOf(table, row) {
  const keys = TABLES[table];
  if (!keys) throw new Error(`unknown table ${table}`);
  return keys.map((k) => {
    if (row[k] === undefined || row[k] === null) throw new Error(`${table}.${k} is required`);
    return String(row[k]);
  });
}

/** Splits a filter into key columns (pushed down to the database) and other fields (checked in JS). */
export function splitWhere(table, where = {}) {
  const keys = TABLES[table];
  const byKey = {};
  const rest = {};
  for (const [k, v] of Object.entries(where)) (keys.includes(k) ? byKey : rest)[k] = v;
  return { byKey, rest };
}

export const matches = (row, rest) => Object.entries(rest).every(([k, v]) => row[k] === v);
