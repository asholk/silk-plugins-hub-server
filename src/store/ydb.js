import { Driver } from "@ydbjs/core";
import { query } from "@ydbjs/query";
import { CredentialsProvider } from "@ydbjs/auth";
import { MetadataCredentialsProvider } from "@ydbjs/auth/metadata";
import { keyOf, matches, splitWhere, TABLES } from "./schema.js";

/**
 * IAM token of the function's service account: Cloud Functions pass a fresh one in each call's context,
 * locally it comes from YDB_ACCESS_TOKEN (yc iam create-token).
 */
export class FunctionTokenProvider extends CredentialsProvider {
  token = "";
  getToken() {
    return Promise.resolve(this.token);
  }
}

/** Builds a template call: parts are trusted YQL (table and column names from the schema), values are bound. */
function tpl(parts, values) {
  const strings = Object.assign([...parts], { raw: [...parts] });
  return [strings, ...values];
}

const ident = (name) => `\`${name}\``;

/**
 * Document store on YDB serverless. Tables are created on first use with the prefix (default "hub_").
 * Keys are Utf8 columns, the row itself is JSON in `doc`.
 */
export async function ydbStore({ connectionString, tokenProvider, prefix = "hub_" }) {
  const credentialsProvider = tokenProvider ?? (process.env.YDB_ACCESS_TOKEN
    ? Object.assign(new FunctionTokenProvider(), { token: process.env.YDB_ACCESS_TOKEN })
    : new MetadataCredentialsProvider({}));
  const driver = new Driver(connectionString, { credentialsProvider });
  await driver.ready(AbortSignal.timeout(15000));
  const sql = query(driver);
  const t = (table) => ident(prefix + table);

  for (const [table, keys] of Object.entries(TABLES)) {
    const cols = keys.map((k) => `${ident(k)} Utf8 NOT NULL`).join(", ");
    const ddl = `CREATE TABLE IF NOT EXISTS ${t(table)} (${cols}, doc Utf8, PRIMARY KEY (${keys.map(ident).join(", ")}))`;
    await sql(...tpl([ddl], []));
  }

  /** "WHERE a = $1 AND b = $2" split into template parts. */
  const select = (table, cols, values) => {
    if (cols.length === 0) return tpl([`SELECT doc FROM ${t(table)}`], []);
    const parts = [`SELECT doc FROM ${t(table)} WHERE ${ident(cols[0])} = `];
    cols.slice(1).forEach((c) => parts.push(` AND ${ident(c)} = `));
    parts.push("");
    return tpl(parts, values);
  };
  const rows = (resultSets) => (resultSets[0] ?? []).map((r) => JSON.parse(r.doc));

  const upsert = (exec, table, row) => {
    const keys = TABLES[table];
    const parts = [`UPSERT INTO ${t(table)} (${[...keys, "doc"].map(ident).join(", ")}) VALUES (`];
    keys.forEach(() => parts.push(", "));
    parts.push(")");
    return exec(...tpl(parts, [...keyOf(table, row), JSON.stringify(row)]));
  };

  return {
    kind: "ydb",
    async get(table, key) {
      const keys = TABLES[table];
      return rows(await sql(...select(table, keys, keyOf(table, key))))[0] ?? null;
    },
    async list(table, where = {}) {
      const { byKey, rest } = splitWhere(table, where);
      const cols = Object.keys(byKey);
      return rows(await sql(...select(table, cols, cols.map((k) => String(byKey[k]))))).filter((r) => matches(r, rest));
    },
    async put(table, row) {
      await upsert(sql, table, row);
      return row;
    },
    async delete(table, key) {
      const keys = TABLES[table];
      const parts = [`DELETE FROM ${t(table)} WHERE ${ident(keys[0])} = `];
      keys.slice(1).forEach((c) => parts.push(` AND ${ident(c)} = `));
      parts.push("");
      await sql(...tpl(parts, keyOf(table, key)));
    },
    async nextId(name) {
      return sql.begin(async (tx) => {
        const [found] = rows(await tx(...select("counters", ["name"], [name])));
        const value = (found?.value ?? 0) + 1;
        await upsert(tx, "counters", { name, value });
        return value;
      });
    },
    async close() {
      driver.close();
    },
  };
}
