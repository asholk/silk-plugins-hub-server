import { compareVersions, nowSec } from "./util.js";

/** Domain helpers over the document store (see store/schema.js). */

export function parseDomains(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export const byName = (a, b) => String(a.name).localeCompare(String(b.name));

export async function findUserByEmail(store, email) {
  return (await store.list("users", { email: email.trim().toLowerCase() }))[0] ?? null;
}

/** Creates or updates the user and attaches them to companies whose email domain matches. */
export async function upsertUser(store, { email, name, googleSub }) {
  email = email.trim().toLowerCase();
  let user = await findUserByEmail(store, email);
  if (!user) {
    user = {
      id: await store.nextId("users"),
      email,
      name: name ?? "",
      google_sub: googleSub ?? null,
      created_at: new Date().toISOString(),
    };
    await store.put("users", user);
  } else if (googleSub && !user.google_sub) {
    user = { ...user, google_sub: googleSub, name: name ?? user.name };
    await store.put("users", user);
  }
  const domain = email.split("@")[1];
  for (const company of await store.list("companies")) {
    if (parseDomains(company.email_domains).includes(domain)) await addMember(store, user.id, company.id);
  }
  return user;
}

export async function addMember(store, userId, companyId) {
  await store.put("memberships", { user_id: Number(userId), company_id: Number(companyId) });
}

export async function userCompanies(store, userId) {
  const ids = new Set((await store.list("memberships", { user_id: userId })).map((m) => m.company_id));
  return (await store.list("companies"))
    .filter((c) => ids.has(c.id))
    .map((c) => ({ id: c.id, slug: c.slug, name: c.name }))
    .sort(byName);
}

export async function isMember(store, userId, companyId) {
  return !!(await store.get("memberships", { user_id: userId, company_id: companyId }));
}

/** Plugins of a company with their "required" flag. */
export async function companyPlugins(store, companyId) {
  const links = await store.list("company_plugins", { company_id: companyId });
  const plugins = new Map((await store.list("plugins")).map((p) => [p.id, p]));
  return links
    .filter((l) => plugins.has(l.plugin_id))
    .map((l) => ({ ...plugins.get(l.plugin_id), required: !!l.required }))
    .sort(byName);
}

/** Can the user see the plugin through any of their companies? */
export async function canSeePlugin(store, userId, pluginId) {
  const companies = new Set((await store.list("memberships", { user_id: userId })).map((m) => m.company_id));
  return (await store.list("company_plugins", { plugin_id: pluginId })).some((l) => companies.has(l.company_id));
}

export async function releasesOf(store, pluginId, { includeRevoked = false } = {}) {
  return (await store.list("releases", { plugin_id: pluginId }))
    .filter((r) => includeRevoked || !r.revoked)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Latest non-revoked release compatible with the given Obsidian version. */
export function latestCompatible(releases, appVersion) {
  return releases.find((r) => !r.revoked && (!appVersion || compareVersions(r.min_app_version, appVersion) <= 0)) ?? null;
}

/** Latest non-revoked release that has the document ("card" or "guide"). */
export function latestWithDoc(releases, doc) {
  return releases.find((r) => !r.revoked && r[doc]) ?? null;
}

export async function deletePluginCascade(store, pluginId) {
  for (const l of await store.list("company_plugins", { plugin_id: pluginId })) await store.delete("company_plugins", l);
  for (const r of await store.list("releases", { plugin_id: pluginId })) await store.delete("releases", r);
  await store.delete("plugins", { id: pluginId });
}

export async function deleteCompanyCascade(store, companyId) {
  for (const l of await store.list("company_plugins", { company_id: companyId })) await store.delete("company_plugins", l);
  for (const m of await store.list("memberships", { company_id: companyId })) await store.delete("memberships", m);
  await store.delete("companies", { id: companyId });
}

/**
 * Counts a hit in a fixed window and tells whether it is within the limit. Approximate across instances,
 * which is enough to cap abuse (download links, sign-in attempts).
 */
export async function withinLimit(store, key, limit, windowSec, cost = 1) {
  const win = Math.floor(nowSec() / windowSec);
  const id = `${key}:${win}`;
  const row = await store.get("rate", { key: id });
  const count = (row?.count ?? 0) + cost;
  await store.put("rate", { key: id, count, exp: (win + 1) * windowSec });
  if (Math.random() < 0.01) void cleanupExpired(store);
  return count <= limit;
}

async function cleanupExpired(store) {
  const now = nowSec();
  for (const r of await store.list("rate")) if (r.exp < now) await store.delete("rate", r);
  for (const s of await store.list("oauth_states")) if (s.created_at < now - 600) await store.delete("oauth_states", s);
  for (const c of await store.list("auth_codes")) if (c.expires_at < now) await store.delete("auth_codes", c);
  for (const t of await store.list("refresh_tokens")) if (t.expires_at < now) await store.delete("refresh_tokens", t);
}
