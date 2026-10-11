const PREFIXES = [
  { type: "new", re: /^(новое|добавлено|new|added|feat)\s*[:—-]\s*/i },
  { type: "improved", re: /^(улучшено|изменено|improved|changed)\s*[:—-]\s*/i },
  { type: "fixed", re: /^(исправлено|fixed|fix)\s*[:—-]\s*/i },
];

/**
 * Extracts changelog items from release notes or a commit message.
 * If a "Changelog:" block is present, only its list items are used; otherwise every list item.
 * An item may explain why it was made after a dash: "- Новое: экспорт в PDF — чтобы делиться заметками".
 */
export function parseChangelog(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^\s*changelog\s*:\s*$/i.test(l));
  const scope = start >= 0 ? lines.slice(start + 1) : lines;
  const items = [];
  for (const raw of scope) {
    const line = raw.trim();
    if (start >= 0 && line === "" && items.length > 0) break;
    const m = line.match(/^[-*•]\s+(.+)$/);
    if (!m) continue;
    let body = m[1].trim();
    let type = "other";
    for (const p of PREFIXES) {
      if (p.re.test(body)) {
        type = p.type;
        body = body.replace(p.re, "");
        break;
      }
    }
    const [text, ...why] = body.split(/\s+[—–]\s+/);
    if (text) items.push({ type, text: text.trim(), why: why.join(" — ").trim() });
  }
  return items;
}
