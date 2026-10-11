export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that escapes interpolations unless they are wrapped with raw(). */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return raw(out);
}

const RAW = Symbol("raw");
export const raw = (s) => ({ [RAW]: true, toString: () => s });

function render(v) {
  if (v == null || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (typeof v === "object" && v[RAW]) return v.toString();
  return esc(v);
}

const STYLE = `
:root { --bg:#f7f7f8; --card:#fff; --text:#1f2328; --muted:#656d76; --line:#d8dee4; --accent:#7c3aed; --danger:#cf222e; --ok:#1a7f37; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8d96a0; --line:#30363d; --accent:#a78bfa; --danger:#f85149; --ok:#3fb950; } }
* { box-sizing:border-box; }
body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; gap:20px; align-items:center; padding:12px 24px; border-bottom:1px solid var(--line); background:var(--card); flex-wrap:wrap; }
header strong { margin-right:12px; }
header a { color:var(--muted); text-decoration:none; }
header a.active, header a:hover { color:var(--text); }
header .spacer { flex:1; }
main { max-width:1100px; margin:0 auto; padding:24px 16px; }
h1 { font-size:22px; margin:0 0 16px; }
h2 { font-size:17px; margin:24px 0 8px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:13px; }
input[type=text], input[type=email], select, textarea { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
button, .btn { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; text-decoration:none; display:inline-block; }
button.primary, .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--danger); }
form.inline { display:inline; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.muted { color:var(--muted); font-size:13px; }
.error { color:var(--danger); }
.ok { color:var(--ok); }
.tag { display:inline-block; padding:0 8px; border-radius:10px; border:1px solid var(--line); font-size:12px; color:var(--muted); }
code { font-size:13px; }
a { color:var(--accent); }
.center { max-width:420px; margin:12vh auto; text-align:center; }
textarea { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
label { white-space:nowrap; }
.plugin-card img { max-width:100%; border-radius:6px; border:1px solid var(--line); }
.plugin-card h1 { font-size:20px; } .plugin-card h2 { font-size:16px; }
`;

export function page({ title, nav, body }) {
  return html`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Silk Plugins Hub</title><style>${raw(STYLE)}</style></head>
<body>${nav ?? ""}<main>${body}</main></body></html>`.toString();
}
