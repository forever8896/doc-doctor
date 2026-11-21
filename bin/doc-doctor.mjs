#!/usr/bin/env node
// doc-doctor: run every code sample in a docs site on a fresh machine.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesFromLlmsFull, pagesFromContextDev, blocksFromPages } from '../src/extract.mjs';
import { classify, RUN_KINDS } from '../src/classify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, targetName, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  }),
);

function usage() {
  console.log(`doc-doctor <command> <target> [flags]

  extract <target>   Read the docs and save every code sample.   [--source=llms|context]
  plan <target>      Show what would run, what is skipped, and the estimated credits.
  run <target>       Run the samples in Boat sandboxes.         [--budget=N] [--only=page-substring] [--kinds=setup,local,api] [--max=N]
  report <target>    Build the HTML report from the latest run.
  watch <target>     Re-read the docs on a timer and run only new or edited samples.  [--every=30m] [--once]
  serve              Local web page: paste a docs address and watch it run.         [--vault] [--port=N]

Targets live in targets/<name>.json. Keys are read from the environment or ~/.config/doc-doctor/env.`);
}

export function loadEnv() {
  const file = join(process.env.HOME, '.config/doc-doctor/env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (cmd === 'serve') {
  const all = process.argv.slice(3);
  if (all.includes('--vault')) process.env.DOC_DOCTOR_VAULT = '1';
  const port = all.find((a) => a.startsWith('--port='));
  if (port) process.env.PORT = port.split('=')[1];
  await import('../src/server.mjs');
  await new Promise(() => {});
}
if (!cmd || !targetName) { usage(); process.exit(cmd ? 1 : 0); }
loadEnv();
const target = JSON.parse(readFileSync(join(root, 'targets', `${targetName}.json`), 'utf8'));
const dataDir = join(root, 'data', targetName);
mkdirSync(dataDir, { recursive: true });
const blocksFile = join(dataDir, 'blocks.json');

function loadPlan() {
  const blocks = JSON.parse(readFileSync(blocksFile, 'utf8'));
  return blocks.map((b) => ({ ...b, ...classify(b, target) }));
}

if (cmd === 'extract') {
  let pages = flags.source === 'context' ? null : await pagesFromLlmsFull(target.site);
  let source = 'llms-full.txt';
  if (!pages) {
    source = 'context.dev';
    pages = await pagesFromContextDev(target.site, process.env.CONTEXT_DEV_API_KEY, { log: console.log });
  }
  const blocks = blocksFromPages(pages);
  writeFileSync(blocksFile, JSON.stringify(blocks, null, 1));
  writeFileSync(join(dataDir, 'pages.json'), JSON.stringify(pages.map(({ url, title }) => ({ url, title })), null, 1));
  console.log(`${pages.length} pages, ${blocks.length} code samples (source: ${source}) -> ${blocksFile}`);
} else if (cmd === 'plan') {
  const plan = loadPlan();
  const by = {};
  for (const b of plan) (by[b.kind] ??= []).push(b);
  for (const [kind, list] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    const langs = {};
    for (const b of list) langs[b.runtime ?? b.lang] = (langs[b.runtime ?? b.lang] ?? 0) + 1;
    console.log(`${RUN_KINDS.has(kind) ? 'RUN ' : 'skip'} ${kind.padEnd(12)} ${String(list.length).padStart(4)}  ${Object.entries(langs).map(([l, n]) => `${l || '(none)'} ${n}`).join(', ')}`);
  }
  const api = by.api ?? [];
  console.log(`\nAPI samples: ${api.length} on ${new Set(api.map((b) => b.url)).size} pages; ${api.filter((b) => b.creates).length} create a resource.`);
  console.log(`Estimated credits: ${api.reduce((s, b) => s + b.estimate, 0)} (estimate ${[...new Set(api.map((b) => b.estimate))].sort((a, b) => a - b).map((e) => `${e}cr x${api.filter((b) => b.estimate === e).length}`).join(', ')})`);
  if (flags.reasons) {
    const reasons = {};
    for (const b of plan) if (b.reason) reasons[b.reason] = (reasons[b.reason] ?? 0) + 1;
    for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), r);
  }
} else if (cmd === 'run') {
  const { run } = await import('../src/run.mjs');
  await run({ root, target, targetName, plan: loadPlan(), flags });
} else if (cmd === 'watch') {
  // Re-read the docs on a timer. When a sample is new or its text changed, run just those samples.
  const { run } = await import('../src/run.mjs');
  const { report } = await import('../src/report.mjs');
  const { createHash } = await import('node:crypto');
  const { readdirSync } = await import('node:fs');
  const every = (() => { const m = String(flags.every ?? '30m').match(/^(\d+)([smh])$/); return m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2]] : 18e5; })();
  const watchFile = join(dataDir, 'watch.json');
  const runsDir = join(root, 'runs', targetName);
  const latestRun = () => (existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'results.json'))).sort().at(-1) : null);
  for (;;) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    try {
      const pages = (await pagesFromLlmsFull(target.site)) ?? (await pagesFromContextDev(target.site, process.env.CONTEXT_DEV_API_KEY));
      const blocks = blocksFromPages(pages);
      const hash = createHash('sha1').update(blocks.map((b) => b.id).sort().join()).digest('hex');
      const seen = existsSync(watchFile) ? JSON.parse(readFileSync(watchFile, 'utf8')) : {};
      const base = flags.baseline ?? seen.runId ?? latestRun();
      let ran = null;
      if (hash === seen.hash && !flags.baseline) console.log(`${stamp}  no change in ${blocks.length} samples`);
      else {
        writeFileSync(blocksFile, JSON.stringify(blocks, null, 1));
        const plan = blocks.map((b) => ({ ...b, ...classify(b, target) }));
        const old = base ? JSON.parse(readFileSync(join(runsDir, base, 'results.json'), 'utf8')).samples : {};
        const fresh = plan.filter((b) => RUN_KINDS.has(b.kind) && !['pass', 'fail', 'timeout', 'plan', 'environment', 'blocked', 'interfered'].includes(old[b.id]?.verdict));
        if (!fresh.length) console.log(`${stamp}  docs changed, but no runnable sample is new or edited`);
        else {
          console.log(`${stamp}  ${fresh.length} new or edited samples on ${new Set(fresh.map((b) => b.url)).size} pages${base ? ` since ${base}` : ''}`);
          ran = await run({ root, target, targetName, plan, flags: { ...flags, carryFrom: base ? join(runsDir, base) : undefined } });
          await report({ root, target, targetName, flags: { run: ran } });
        }
        writeFileSync(watchFile, JSON.stringify({ hash, runId: ran ?? base, checkedAt: new Date().toISOString() }));
      }
    } catch (e) {
      console.log(`${stamp}  check failed: ${String(e.message ?? e).slice(0, 200)}`);
    }
    if (flags.once) break;
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === 'serve') {
  if (flags.vault) process.env.DOC_DOCTOR_VAULT = '1';
  if (flags.port) process.env.PORT = String(flags.port);
  await import('../src/server.mjs');
} else if (cmd === 'report') {
  const { report } = await import('../src/report.mjs');
  await report({ root, target, targetName, flags });
} else usage();
