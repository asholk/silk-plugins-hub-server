import { upsertUser, withinLimit } from "./data.js";
import { html, page } from "./html.js";
import { nowSec, randomToken, sha256B64Url, sha256Hex, signToken, verifyToken } from "./util.js";

const STATE_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
export const PLUGIN_CALLBACK = "obsidian://silk-hub-auth";

export async function issueTokens(ctx, userId) {
  const { store, config } = ctx;
  const accessToken = signToken({ uid: userId, typ: "access", exp: nowSec() + config.accessTokenTtlSec }, config.sessionSecret);
  const refreshToken = randomToken();
  await store.put("refresh_tokens", {
    token_hash: sha256Hex(refreshToken),
    user_id: userId,
    expires_at: nowSec() + config.refreshTokenTtlSec,
  });
  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSec };
}

/** Returns the user for a valid Bearer access token, or null. */
export async function userFromRequest(ctx, request) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token, ctx.config.sessionSecret);
  if (!payload || payload.typ !== "access" || !Number.isInteger(payload.uid)) return null;
  return ctx.store.get("users", { id: payload.uid });
}

function googleConfigured(config) {
  return !!(config.google.clientId && config.google.clientSecret);
}

function message(title, text) {
  return page({ title, body: html`<div class="center card"><h1>${title}</h1><p>${text}</p></div>` });
}

export function registerAuthRoutes(app, ctx) {
  const { store, config } = ctx;
  const redirectUri = `${config.baseUrl}/auth/google/callback`;

  // Sign-in endpoints write to the store, so they are limited per IP.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/auth/") || (req.method === "GET" && req.url.startsWith("/auth/dev"))) return;
    if (!(await withinLimit(store, `auth:${req.ip}`, config.limits.authPer10Min, 600))) {
      return reply.code(429).send({ error: "too many requests" });
    }
  });

  async function beginLogin(reply, { kind, clientState = "", challenge = "" }) {
    const state = randomToken(24);
    await store.put("oauth_states", { state, kind, client_state: clientState, challenge, created_at: nowSec() });
    if (googleConfigured(config)) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: config.google.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
      }).toString();
      return reply.redirect(url.toString());
    }
    if (config.devLogin) return reply.redirect(`/auth/dev?state=${encodeURIComponent(state)}`);
    return reply.code(503).type("text/html").send(message("Вход недоступен", "Google OAuth не настроен на сервере."));
  }

  async function takeState(state) {
    if (!state) return null;
    const row = await store.get("oauth_states", { state: String(state) });
    if (!row) return null;
    await store.delete("oauth_states", row);
    return row.created_at >= nowSec() - STATE_TTL ? row : null;
  }

  async function completeLogin(reply, stateRow, profile) {
    const user = await upsertUser(store, profile);
    const code = randomToken();
    await store.put("auth_codes", { code_hash: sha256Hex(code), user_id: user.id, challenge: stateRow.challenge, expires_at: nowSec() + CODE_TTL });
    const target = `${PLUGIN_CALLBACK}?${new URLSearchParams({ code, state: stateRow.client_state })}`;
    const body = html`<div class="center card">
      <h1>Вход выполнен</h1>
      <p>${user.email}</p>
      <p><a class="btn primary" href="${target}">Вернуться в Obsidian</a></p>
      <p class="muted">Если Obsidian не открылся сам, нажмите кнопку выше. Эту вкладку можно закрыть.</p>
      <script>location.href = ${JSON.stringify(target).replace(/</g, "\\u003c")};</script>
    </div>`;
    return reply.type("text/html").send(page({ title: "Вход выполнен", body }));
  }

  // Hub users sign in with Google only: the plugin opens this URL in the system browser with a PKCE challenge.
  app.get("/auth/start", async (req, reply) => {
    const { state, challenge } = req.query;
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(String(challenge ?? ""))) {
      return reply.code(400).send({ error: "state and S256 challenge are required" });
    }
    return beginLogin(reply, { kind: "plugin", clientState: String(state), challenge: String(challenge) });
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const stateRow = await takeState(req.query.state);
    if (!stateRow) return reply.code(400).type("text/html").send(message("Ссылка устарела", "Начните вход заново."));
    if (req.query.error) return reply.code(400).type("text/html").send(message("Вход отменён", String(req.query.error)));
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code ?? ""),
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      req.log.error(`google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
      return reply.code(502).type("text/html").send(message("Ошибка входа", "Google не подтвердил вход. Попробуйте ещё раз."));
    }
    const { access_token } = await tokenRes.json();
    const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.email || !info.email_verified) {
      return reply.code(403).type("text/html").send(message("Ошибка входа", "Почта Google не подтверждена."));
    }
    return completeLogin(reply, stateRow, { email: info.email, name: info.name, googleSub: info.sub });
  });

  if (config.devLogin) {
    app.get("/auth/dev", async (req, reply) => {
      const body = html`<div class="center card"><h1>Dev-вход</h1>
        <p class="muted">Только для локальной разработки (DEV_LOGIN=1).</p>
        <form method="post" action="/auth/dev" class="row" style="justify-content:center">
          <input type="hidden" name="state" value="${req.query.state}">
          <input type="email" name="email" placeholder="you@example.com" required autofocus>
          <button class="primary">Войти</button>
        </form></div>`;
      return reply.type("text/html").send(page({ title: "Dev-вход", body }));
    });
    app.post("/auth/dev", async (req, reply) => {
      const stateRow = await takeState(req.body?.state);
      if (!stateRow) return reply.code(400).type("text/html").send(message("Ссылка устарела", "Начните вход заново."));
      const email = String(req.body?.email ?? "").trim();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return reply.code(400).send({ error: "invalid email" });
      return completeLogin(reply, stateRow, { email, name: email.split("@")[0] });
    });
  }

  // Exchanges a one-time code from the obsidian:// callback for tokens (PKCE S256).
  app.post("/auth/token", async (req, reply) => {
    const { code, verifier } = req.body ?? {};
    const row = await store.get("auth_codes", { code_hash: sha256Hex(String(code ?? "")) });
    if (row) await store.delete("auth_codes", row);
    if (!row || row.expires_at < nowSec() || sha256B64Url(String(verifier ?? "")) !== row.challenge) {
      return reply.code(400).send({ error: "invalid_grant" });
    }
    return issueTokens(ctx, row.user_id);
  });

  app.post("/auth/refresh", async (req, reply) => {
    const hash = sha256Hex(String(req.body?.refreshToken ?? ""));
    const row = await store.get("refresh_tokens", { token_hash: hash });
    if (row) await store.delete("refresh_tokens", row);
    if (!row || row.expires_at < nowSec()) return reply.code(401).send({ error: "invalid_grant" });
    return issueTokens(ctx, row.user_id);
  });

  app.post("/auth/logout", async (req) => {
    await store.delete("refresh_tokens", { token_hash: sha256Hex(String(req.body?.refreshToken ?? "")) });
    return { ok: true };
  });
}
