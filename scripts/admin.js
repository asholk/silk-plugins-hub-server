// Creates an admin or resets their password:
//   npm run admin -- <username> [password]
// Without a password a random one is generated and printed once. Uses the store from .env
// (SQLite locally; YDB with STORE=ydb and YDB_ACCESS_TOKEN from `yc iam create-token`).
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { openStore } from "../src/server.js";
import { setAdminPassword } from "../src/admin/auth.js";

const [username, given] = process.argv.slice(2);
if (!username) {
  console.error("Usage: npm run admin -- <username> [password]");
  process.exit(1);
}
const password = given ?? crypto.randomBytes(12).toString("base64url");
const store = await openStore(loadConfig());
await setAdminPassword(store, username, password);
await store.close();
console.log(`Admin "${username}" saved.${given ? "" : ` Password: ${password}`}`);
process.exit(0);
