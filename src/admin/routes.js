import { adminFromRequest, registerAdminAuthRoutes } from "./auth.js";
import {
  addMember,
  byName,
  deleteCompanyCascade,
  deletePluginCascade,
  latestWithDoc,
  parseDomains,
  releasesOf,
  upsertUser,
} from "../data.js";
import { resolveCardImages } from "../card.js";
import { newPublishToken } from "../publish.js";
import { isValidPluginId, isValidVersion } from "../util.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

const str = (v) => String(v ?? "").trim();
/** [{id, required}] from a request body list; ids are normalised by `toId`. */
const accessList = (v, toId) =>
  (Array.isArray(v) ? v : []).map((x) => ({ id: toId(x?.id), required: !!x?.required })).filter((x) => x.id !== null);

const companyOut = (c) => ({ id: c.id, name: c.name, slug: c.slug, emailDomains: c.email_domains ?? "" });
const userOut = (u) => ({ id: u.id, email: u.email, name: u.name ?? "", signedIn: !!u.google_sub, createdAt: u.created_at ?? null });
const pluginOut = (p) => ({
  id: p.id,
  name: p.name,
  repo: p.repo ?? "",
  description: p.description ?? "",
  instructions: p.instructions ?? "",
  hasPublishToken: !!p.publish_token_hash,
});

/**
 * JSON API of the admin plugin (Silk Plugins Hub Admin) under /admin-api. Admins sign in with login and
 * password and send the issued token as `Authorization: Bearer`; Hub users' tokens don't work here.
 */
export function registerAdminRoutes(app, ctx) {
  const { store, config } = ctx;

  // Optional allow-list: the admin API is invisible from other addresses.
  if (config.adminAllowedIps.length > 0) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.url.startsWith("/admin-api") && !config.adminAllowedIps.includes(req.ip)) return reply.code(404).send({ error: "not found" });
    });
  }

  registerAdminAuthRoutes(app, ctx);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin-api/") || req.url.startsWith("/admin-api/login") || req.url.startsWith("/admin-api/logout")) return;
    req.admin = await adminFromRequest(ctx, req);
    if (!req.admin) return reply.code(401).send({ error: "unauthorized" });
  });

  const bad = (reply, error) => reply.code(400).send({ error });
  const notFound = (reply) => reply.code(404).send({ error: "not found" });
  const companyById = (id) => (Number.isInteger(Number(id)) ? store.get("companies", { id: Number(id) }) : null);
  const pluginById = (id) => (isValidPluginId(id) ? store.get("plugins", { id }) : null);

  app.get("/admin-api/me", async (req) => ({ username: req.admin.username, hubUrl: config.baseUrl }));

  // ---------- Companies ----------
  app.get("/admin-api/companies", async () => {
    const companies = (await store.list("companies")).sort(byName);
    const memberships = await store.list("memberships");
    const links = await store.list("company_plugins");
    return {
      companies: companies.map((c) => ({
        ...companyOut(c),
        members: memberships.filter((m) => m.company_id === c.id).length,
        plugins: links.filter((l) => l.company_id === c.id).map((l) => ({ id: l.plugin_id, required: !!l.required })),
      })),
    };
  });

  app.post("/admin-api/companies", async (req, reply) => {
    const name = str(req.body?.name);
    const slug = str(req.body?.slug).toLowerCase();
    if (!name || !SLUG_RE.test(slug)) return bad(reply, "name and a code of latin letters, digits and hyphens are required");
    if ((await store.list("companies", { slug })).length) return reply.code(409).send({ error: `code ${slug} is taken` });
    const id = await store.nextId("companies");
    const company = { id, name, slug, email_domains: parseDomains(req.body?.emailDomains).join(", ") };
    await store.put("companies", company);
    for (const p of accessList(req.body?.plugins, (x) => (isValidPluginId(x) ? x : null))) {
      await store.put("company_plugins", { company_id: id, plugin_id: p.id, required: p.required });
    }
    return companyOut(company);
  });

  app.get("/admin-api/companies/:id", async (req, reply) => {
    const company = await companyById(req.params.id);
    if (!company) return notFound(reply);
    const memberIds = new Set((await store.list("memberships", { company_id: company.id })).map((m) => m.user_id));
    const members = (await store.list("users")).filter((u) => memberIds.has(u.id)).sort((a, b) => a.email.localeCompare(b.email));
    const links = await store.list("company_plugins", { company_id: company.id });
    return {
      company: companyOut(company),
      members: members.map(userOut),
      plugins: links.map((l) => ({ id: l.plugin_id, required: !!l.required })),
    };
  });

  app.patch("/admin-api/companies/:id", async (req, reply) => {
    const company = await companyById(req.params.id);
    if (!company) return notFound(reply);
    const next = { ...company };
    if (req.body?.name !== undefined) next.name = str(req.body.name) || company.name;
    if (req.body?.emailDomains !== undefined) next.email_domains = parseDomains(req.body.emailDomains).join(", ");
    await store.put("companies", next);
    return companyOut(next);
  });

  app.delete("/admin-api/companies/:id", async (req) => {
    await deleteCompanyCascade(store, Number(req.params.id));
    return { ok: true };
  });

  /** Replaces the company's plugin list: [{id, required}]. */
  app.put("/admin-api/companies/:id/plugins", async (req, reply) => {
    const company = await companyById(req.params.id);
    if (!company) return notFound(reply);
    for (const l of await store.list("company_plugins", { company_id: company.id })) await store.delete("company_plugins", l);
    for (const p of accessList(req.body?.plugins, (x) => (isValidPluginId(x) ? x : null))) {
      await store.put("company_plugins", { company_id: company.id, plugin_id: p.id, required: p.required });
    }
    return { ok: true };
  });

  app.post("/admin-api/companies/:id/members", async (req, reply) => {
    const company = await companyById(req.params.id);
    if (!company) return notFound(reply);
    const email = str(req.body?.email);
    if (!EMAIL_RE.test(email)) return bad(reply, "invalid email");
    const user = await upsertUser(store, { email });
    await addMember(store, user.id, company.id);
    return userOut(user);
  });

  app.delete("/admin-api/companies/:id/members/:userId", async (req) => {
    await store.delete("memberships", { user_id: Number(req.params.userId), company_id: Number(req.params.id) });
    return { ok: true };
  });

  // ---------- Users ----------
  app.get("/admin-api/users", async () => {
    const users = (await store.list("users")).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const memberships = await store.list("memberships");
    return {
      users: users.map((u) => ({
        ...userOut(u),
        companyIds: memberships.filter((m) => m.user_id === u.id).map((m) => m.company_id),
      })),
    };
  });

  app.put("/admin-api/users/:id/companies", async (req, reply) => {
    const userId = Number(req.params.id);
    if (!(await store.get("users", { id: userId }))) return notFound(reply);
    const ids = new Set((Array.isArray(req.body?.companyIds) ? req.body.companyIds : []).map(Number).filter(Number.isInteger));
    for (const m of await store.list("memberships", { user_id: userId })) {
      if (!ids.has(m.company_id)) await store.delete("memberships", m);
    }
    for (const id of ids) if (await store.get("companies", { id })) await addMember(store, userId, id);
    return { ok: true };
  });

  // ---------- Plugins ----------
  app.get("/admin-api/plugins", async () => {
    const plugins = [];
    for (const p of (await store.list("plugins")).sort(byName)) {
      const [latest] = await releasesOf(store, p.id);
      plugins.push({ ...pluginOut(p), latest: latest ? { version: latest.version, publishedAt: latest.published_at } : null });
    }
    return { plugins };
  });

  const pluginFields = (b, current = {}) => {
    const out = { ...current };
    for (const key of ["name", "repo", "description", "instructions"]) if (b[key] !== undefined) out[key] = str(b[key]);
    return out;
  };

  app.post("/admin-api/plugins", async (req, reply) => {
    const id = str(req.body?.id);
    if (!isValidPluginId(id)) return bad(reply, "invalid plugin id");
    if (await store.get("plugins", { id })) return reply.code(409).send({ error: `plugin ${id} already exists` });
    const fields = pluginFields(req.body ?? {}, { name: "", repo: "", description: "", instructions: "" });
    if (!fields.name) return bad(reply, "name is required");
    const plugin = { id, ...fields, publish_token_hash: null };
    await store.put("plugins", plugin);
    return pluginOut(plugin);
  });

  app.get("/admin-api/plugins/:id", async (req, reply) => {
    const plugin = await pluginById(req.params.id);
    if (!plugin) return notFound(reply);
    const releases = await releasesOf(store, plugin.id, { includeRevoked: true });
    const links = await store.list("company_plugins", { plugin_id: plugin.id });
    const doc = async (kind) => {
      const rel = latestWithDoc(releases, kind);
      return rel ? { version: rel.version, markdown: await resolveCardImages(ctx, rel, rel[kind]) } : null;
    };
    return {
      plugin: pluginOut(plugin),
      companies: links.map((l) => ({ id: l.company_id, required: !!l.required })),
      releases: releases.map((r) => ({
        version: r.version,
        publishedAt: r.published_at,
        minAppVersion: r.min_app_version,
        revoked: !!r.revoked,
        changes: r.changes ?? [],
      })),
      card: await doc("card"),
      guide: await doc("guide"),
    };
  });

  app.patch("/admin-api/plugins/:id", async (req, reply) => {
    const plugin = await pluginById(req.params.id);
    if (!plugin) return notFound(reply);
    const next = pluginFields(req.body ?? {}, plugin);
    if (!next.name) next.name = plugin.name;
    await store.put("plugins", next);
    return pluginOut(next);
  });

  app.delete("/admin-api/plugins/:id", async (req) => {
    if (isValidPluginId(req.params.id)) await deletePluginCascade(store, req.params.id);
    return { ok: true };
  });

  // The token is returned once; only its hash is kept.
  app.post("/admin-api/plugins/:id/token", async (req, reply) => {
    const plugin = await pluginById(req.params.id);
    if (!plugin) return notFound(reply);
    const { token, hash } = newPublishToken();
    await store.put("plugins", { ...plugin, publish_token_hash: hash });
    return { token, hubUrl: config.baseUrl };
  });

  /** Replaces the plugin's company access: [{id, required}]. */
  app.put("/admin-api/plugins/:id/companies", async (req, reply) => {
    const plugin = await pluginById(req.params.id);
    if (!plugin) return notFound(reply);
    for (const l of await store.list("company_plugins", { plugin_id: plugin.id })) await store.delete("company_plugins", l);
    for (const c of accessList(req.body?.companies, (x) => (Number.isInteger(Number(x)) ? Number(x) : null))) {
      await store.put("company_plugins", { company_id: c.id, plugin_id: plugin.id, required: c.required });
    }
    return { ok: true };
  });

  for (const [action, revoked] of [["revoke", true], ["restore", false]]) {
    app.post(`/admin-api/plugins/:id/releases/:version/${action}`, async (req, reply) => {
      const { id, version } = req.params;
      const rel = isValidPluginId(id) && isValidVersion(version) ? await store.get("releases", { plugin_id: id, version }) : null;
      if (!rel) return notFound(reply);
      await store.put("releases", { ...rel, revoked });
      return { ok: true };
    });
  }
}
