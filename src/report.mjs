// Build a single self-contained HTML report from a run's results.json and recordings.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rejudge } from './classify.mjs';

export async function report({ root, target, targetName, flags }) {
  const runsDir = join(root, 'runs', targetName);
  const runId = flags.run ?? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'results.json'))).sort().at(-1);
  const runDir = join(runsDir, runId);
  const state = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));
  for (const s of Object.values(state.samples)) rejudge(s, target);
  // Samples that create something often print a secret for it (a webhook signing secret, a new token). Mask those in the report.
  const mask = (text) => text && text
    .replace(/\b(whsec|sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9+/=_-]{8,}/g, '$1_[hidden]')
    .replace(/((?:\\*)"(?:secret|signing_secret|token|access_token|api_key|apiKey|password)(?:\\*)":\s*(?:\\*)")(?!YOUR_|\$|<)[^"\\]{8,}/g, '$1[hidden]');
  const cast = (rel) => (rel && existsSync(join(runDir, rel)) ? mask(readFileSync(join(runDir, rel), 'utf8')) : null);

  const data = {
    target: state.target, site: state.site, runId, startedAt: state.startedAt, finishedAt: state.finishedAt,
    spent: state.spent, budget: state.budget, vault: state.vault ?? null, environment: state.environment ?? null, refusedLabel: target.refusedLabel ?? 'refused by plan', setupSource: target.setupSource,
    samples: Object.values(state.samples).map((s) => ({
      id: s.id, url: s.url, page: s.page, heading: s.heading, lang: s.runtime ?? s.lang, label: s.label, kind: s.kind,
      verdict: s.verdict, reason: s.reason ?? null, exit: s.exit, ms: s.ms, http: s.http, credits: s.credits,
      code: s.code, tail: mask(s.tail), cast: cast(s.cast),
    })),
    setups: state.setups.map((s) => ({ ...s, cast: cast(s.cast) })),
  };
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'report.html'), 'utf8');
  const html = template.replace('/*DATA*/null', () => JSON.stringify(data).replace(/</g, '\\u003c'));
  const out = join(runDir, 'index.html');
  writeFileSync(out, html);
  console.log(`${out} (${(html.length / 1e6).toFixed(1)} MB, ${data.samples.length} samples)`);
}
