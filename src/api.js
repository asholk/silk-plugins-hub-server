import { userFromRequest } from "./auth.js";
import {
  byName,
  canSeePlugin,
  companyPlugins,
  isMember,
  latestCompatible,
  latestWithDoc,
  releasesOf,
  userCompanies,
  withinLimit,
} from "./data.js";
import { compareVersions } from "./util.js";
import { resolveCardImages } from "./card.js";
import { ASSET_NAMES } from "./releases.js";

/**
 * Plugins of several companies, merged by plugin id: a plugin offered by two companies appears once,
 * lists both of them and is required if any company requires it.
 */
async function companiesPlugins(store, companyIds) {
  const byId = new Map();
  for (const companyId of companyIds) {
    for (const p of await companyPlugins(store, companyId)) {
      const seen = byId.get(p.id);
      if (seen) {
        seen.required = seen.required || p.required;
        seen.companies.push(companyId);
      } else byId.set(p.id, { ...p, companies: [companyId] });
    }
  }
  return [...byId.values()].sort(byName);
}

const releaseInfo = (release) => ({
  version: release.version,
  minAppVersion: release.min_app_version,
  publishedAt: release.published_at,
  changes: release.changes,
});

export function registerApiRoutes(app, ctx) {
  const { store, config } = ctx;

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const user = await userFromRequest(ctx, req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    req.user = user;
  });

  /** Company ids from a list or "1,2"; every one must be the user's company. */
  async function requireCompanies(req, reply, raw) {
    const ids = [...new Set((Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map(Number))];
    let ok = ids.length > 0 && ids.length <= 20;
    for (const id of ids) ok = ok && Number.isInteger(id) && (await isMember(store, req.user.id, id));
    if (!ok) {
      reply.code(403).send({ error: "not a member of this company" });
      return null;
    }
    return ids;
  }

  async function catalogResponse(companyIds, appVersion) {
    const plugins = [];
    for (const p of await companiesPlugins(store, companyIds)) {
      const releases = await releasesOf(store, p.id);
      const rel = latestCompatible(releases, appVersion);
      plugins.push({
        id: p.id,
        name: p.name,
        description: p.description,
        instructions: p.instructions,
        required: p.required,
        companies: p.companies,
        hasCard: !!latestWithDoc(releases, "card"),
        hasGuide: !!latestWithDoc(releases, "guide"),
        latest: rel ? releaseInfo(rel) : null,
      });
    }
    return { plugins };
  }

  app.get("/api/me", async (req) => ({
    user: { id: req.user.id, email: req.user.email, name: req.user.name },
    companies: await userCompanies(store, req.user.id),
  }));

  // The user types the company code (or name) in the plugin. Unknown companies and companies the user
  // isn't a member of get the same answer, so codes can't be probed.
  app.get("/api/companies/lookup", async (req, reply) => {
    const code = String(req.query.code ?? "").trim().toLowerCase();
    const company = (await userCompanies(store, req.user.id)).find(
      (c) => c.slug.toLowerCase() === code || c.name.toLowerCase() === code,
    );
    if (!code || !company) return reply.code(404).send({ error: "company_not_found" });
    return { company };
  });

  app.get("/api/companies/:id/plugins", async (req, reply) => {
    const companyIds = await requireCompanies(req, reply, [req.params.id]);
    if (companyIds === null) return reply;
    return catalogResponse(companyIds, req.query.appVersion ? String(req.query.appVersion) : null);
  });

  // Plugins of all the companies the vault is connected to.
  app.get("/api/catalog", async (req, reply) => {
    const companyIds = await requireCompanies(req, reply, req.query.companies);
    if (companyIds === null) return reply;
    return catalogResponse(companyIds, req.query.appVersion ? String(req.query.appVersion) : null);
  });

  /**
   * Body: { companyIds, selected: string[], installed: { [id]: version }, appVersion }
   * Returns plugins to install or update (selected + required), with changelog since the installed version
   * and short-lived download links. Links count against the user's hourly download quota.
   */
  app.post("/api/updates/check", async (req, reply) => {
    const body = req.body ?? {};
    const companyIds = await requireCompanies(req, reply, body.companyIds ?? [body.companyId]);
    if (companyIds === null) return reply;
    const selected = new Set(Array.isArray(body.selected) ? body.selected.map(String) : []);
    const installed = body.installed && typeof body.installed === "object" ? body.installed : {};
    const appVersion = body.appVersion ? String(body.appVersion) : null;
    const available = await companiesPlugins(store, companyIds);

    const updates = [];
    for (const p of available) {
      if (!p.required && !selected.has(p.id)) continue;
      const all = await releasesOf(store, p.id, { includeRevoked: true });
      const rel = latestCompatible(all, appVersion);
      if (!rel) continue;
      const current = installed[p.id] ? String(installed[p.id]) : null;
      const revoked = current ? all.some((r) => r.version === current && r.revoked) : false;
      if (current && !revoked && compareVersions(current, rel.version) >= 0) continue;

      const history = all
        .filter((r) => !r.revoked)
        .filter((r) => compareVersions(r.version, rel.version) <= 0 && (!current || revoked || compareVersions(r.version, current) > 0))
        .map(releaseInfo);
      updates.push({ p, rel, current, revoked, history });
    }

    const files = updates.reduce((n, u) => n + u.rel.assets.filter((a) => ASSET_NAMES.includes(a.name)).length, 0);
    if (files > 0 && !(await withinLimit(store, `dl:${req.user.id}`, config.limits.downloadsPerHour, 3600, files))) {
      return reply.code(429).send({ error: "download quota exceeded, try again in an hour" });
    }

    const result = [];
    for (const { p, rel, current, revoked, history } of updates) {
      const assets = [];
      for (const a of rel.assets.filter((x) => ASSET_NAMES.includes(x.name))) {
        assets.push({ name: a.name, sha256: a.sha256, size: a.size, url: await ctx.files.url(a.key, config.fileLinkTtlSec) });
      }
      result.push({
        id: p.id,
        name: p.name,
        instructions: p.instructions,
        required: p.required,
        installedVersion: current,
        version: rel.version,
        minAppVersion: rel.min_app_version,
        reason: !current ? "install" : revoked ? "revoked" : "update",
        changelog: history,
        assets,
      });
    }
    const availableIds = new Set(available.map((p) => p.id));
    const removed = [...selected].filter((id) => !availableIds.has(id));
    return { updates: result, removed };
  });

  // Plugin card (overview) and guide (detailed instructions), Markdown with signed image links.
  app.get("/api/plugins/:id/:doc(card|guide)", async (req, reply) => {
    if (!(await canSeePlugin(store, req.user.id, req.params.id))) return reply.code(404).send({ error: "not found" });
    const { doc } = req.params;
    const rel = latestWithDoc(await releasesOf(store, req.params.id), doc);
    if (!rel) return reply.code(404).send({ error: `no ${doc}` });
    return { version: rel.version, markdown: await resolveCardImages(ctx, rel, rel[doc]) };
  });

  app.get("/api/plugins/:id/changelog", async (req, reply) => {
    if (!(await canSeePlugin(store, req.user.id, req.params.id))) return reply.code(404).send({ error: "not found" });
    return { releases: (await releasesOf(store, req.params.id)).map(releaseInfo) };
  });
}
