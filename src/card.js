import { isCardImage } from "./releases.js";

/**
 * Points image links of a card or guide to signed, time-limited file links, so they load in <img>
 * (Silk Plugins Hub and the admin plugin) without an Authorization header.
 */
export async function resolveCardImages(ctx, release, markdown = release.card) {
  const images = new Map(release.assets.filter((a) => isCardImage(a.name)).map((a) => [a.name, a.key]));
  const urls = new Map();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\((?:\.\/)?([^)\s]+)/g)) {
    const key = images.get(m[1]);
    if (key && !urls.has(m[1])) urls.set(m[1], await ctx.files.url(key, ctx.config.cardLinkTtlSec));
  }
  return markdown.replace(/(!\[[^\]]*\]\()(?:\.\/)?([^)\s]+)((?:\s+"[^"]*")?\))/g, (all, open, target, close) =>
    urls.has(target) ? `${open}${urls.get(target)}${close}` : all,
  );
}
