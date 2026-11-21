// Turn a documentation site into a list of code samples.
//
// Two sources, tried in this order:
//   1. The site's own llms-full.txt (many docs sites publish one). Free.
//   2. context.dev: map the site, then scrape each page as Markdown. 1 credit per page.
import { createHash } from 'node:crypto';

const API = 'https://api.context.dev/v1';

async function ctx(key, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`context.dev ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Pages as [{ url, title, markdown }] from <site>/llms-full.txt, or null if there is none. */
export async function pagesFromLlmsFull(site) {
  const res = await fetch(new URL('/llms-full.txt', site));
  if (!res.ok) return null;
  const text = await res.text();
  const parts = text.split(/^# (.+)\nSource: (\S+)\n/m);
  const pages = [];
  for (let i = 1; i < parts.length; i += 3) {
    pages.push({ title: parts[i].trim(), url: parts[i + 1], markdown: parts[i + 2] });
  }
  return pages.length ? pages : null;
}

/** Pages through context.dev: one map call, then one scrape per page. */
export async function pagesFromContextDev(site, key, { limit = 500, log = () => {} } = {}) {
  const map = await ctx(key, 'GET', `/web/urls?url=${encodeURIComponent(site)}`);
  const urls = (map.urls ?? map.data ?? []).map((u) => (typeof u === 'string' ? u : u.url)).slice(0, limit);
  const pages = [];
  for (const url of urls) {
    log(`scrape ${url}`);
    const page = await ctx(key, 'POST', '/web/scrape', { url, formats: { markdown: true } });
    pages.push({ url, title: page.metadata?.title ?? url, markdown: page.markdown?.data ?? '' });
    await new Promise((r) => setTimeout(r, 6500)); // stay under 10 requests a minute
  }
  return pages;
}

/** Every fenced code block on every page, with the heading it sits under. */
export function blocksFromPages(pages) {
  const blocks = [];
  for (const page of pages) {
    let heading = '';
    let open = null;
    for (const line of page.markdown.split('\n')) {
      const fence = line.match(/^\s*(`{3,})(.*)$/);
      if (open) {
        if (fence && fence[1].length >= open.ticks && !fence[2].trim()) {
          const code = open.lines.join('\n').replace(/\s+$/, '') + '\n';
          const indent = Math.min(...open.lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length), 99);
          blocks.push({
            id: createHash('sha1').update(page.url + '\0' + open.lang + '\0' + code).digest('hex').slice(0, 10),
            url: page.url,
            page: page.title,
            heading,
            lang: open.lang,
            label: open.label,
            code: indent && indent < 99 ? code.split('\n').map((l) => l.slice(indent)).join('\n') : code,
          });
          open = null;
        } else open.lines.push(line);
        continue;
      }
      if (fence) {
        const [lang = '', ...rest] = fence[2].trim().replace(/\b\w+=\{.*\}/g, '').trim().split(/\s+/);
        const label = rest.filter((w) => !/^(theme|icon|lines|wrap|expandable|highlight)=/.test(w)).join(' ');
        open = { ticks: fence[1].length, lang: lang.toLowerCase(), label, lines: [] };
        continue;
      }
      const h = line.match(/^#{2,4}\s+(.*)$/);
      if (h) heading = h[1].trim();
    }
  }
  // The same sample can be published under two URLs; keep the first.
  const seen = new Set();
  return blocks.filter((b) => (seen.has(b.id) ? false : seen.add(b.id)));
}
