import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";
import { FunctionTokenProvider } from "./store/ydb.js";

/**
 * Yandex Cloud Functions entry point behind API Gateway: the whole Fastify app runs in the function,
 * requests are passed in with inject(). The app is built once per instance.
 */
const tokenProvider = new FunctionTokenProvider();
let ready = null;

function getApp() {
  ready ??= buildApp(loadConfig({ ...process.env, TRUST_PROXY: "0" }), { logger: { level: "info" }, tokenProvider })
    .then(async ({ app }) => {
      await app.ready();
      return app;
    })
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

function requestUrl(event) {
  if (event.url) return event.url;
  const qs = new URLSearchParams();
  for (const [k, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) for (const v of values) qs.append(k, v);
  const query = qs.toString();
  return (event.path ?? "/") + (query ? `?${query}` : "");
}

export async function handler(event, context) {
  if (context?.token?.access_token) tokenProvider.token = context.token.access_token;
  const app = await getApp();
  const res = await app.inject({
    method: event.httpMethod,
    url: requestUrl(event),
    headers: event.headers ?? {},
    payload: event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : undefined,
    remoteAddress: event.requestContext?.identity?.sourceIp ?? "0.0.0.0",
  });

  const headers = {};
  const multiValueHeaders = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) multiValueHeaders[name] = value.map(String);
    else headers[name] = String(value);
  }
  const type = String(res.headers["content-type"] ?? "");
  const text = /^(text\/|application\/(json|javascript)|image\/svg)/.test(type) || type === "";
  return {
    statusCode: res.statusCode,
    headers,
    multiValueHeaders,
    body: text ? res.payload : res.rawPayload.toString("base64"),
    isBase64Encoded: !text,
  };
}
