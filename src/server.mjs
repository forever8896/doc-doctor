// The local interface: paste a docs URL, optionally an API key, and watch every sample run.
// It is meant to run on your own machine (it listens on localhost only) with your own accounts.
//
// Where secrets live:
//   - Boat: your own signed-in Boat CLI. It starts and stops the machines and never enters one.
//   - The API key, default: kept in this process and written into the sandboxes for the run.
//   - The API key, with `serve --vault`: stored as a binding in your own 1Claw account. The sandboxes
//     call the API through the vault and never hold the key.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { pagesFromLlmsFull, pagesFromContextDev, blocksFromPages } from './extract.mjs';
import { classify, rejudge, RUN_KINDS } from './classify.mjs';
import { autoTarget } from './autotarget.mjs';
import { run } from './run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8797);
const cfgDir = join(process.env.HOME, '.config/doc-doctor');
for (const f of ['env', '1claw.env']) {
  const p = join(cfgDir, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const VAULT = process.env.DOC_DOCTOR_VAULT === '1';
const jobs = new Map(); // runId -> { name, phase, error, site, detected, plan }

function oneclaw(args) {
  return new Promise((res) => {
    // Creating a binding is an owner action: use the owner's 1Claw session, not the scoped agent key.
    const env = { ...process.env };
    delete env.ONECLAW_AGENT_API_KEY;
    const c = spawn('1claw', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => res({ code, out }));
    c.on('error', (e) => res({ code: 1, out: String(e) }));
  });
}

/** Put the visitor's key into a 1Claw binding limited to the API host. */
async function storeKey(target, apiKey) {
  const agent = process.env.ONECLAW_AGENT_ID;
  if (!agent) throw new Error('This server has no 1Claw agent configured, so it cannot accept keys.');
  const { binding, host, header } = target.vault;
  const hostsFile = join(cfgDir, 'vault-hosts.json');
  const hosts = new Set(existsSync(hostsFile) ? JSON.parse(readFileSync(hostsFile, 'utf8')) : ['api.context.dev']);
  if (!hosts.has(host)) {
    hosts.add(host);
    const g = await oneclaw(['agent', 'update', agent, '--execution-guardrails', JSON.stringify({ allowed_hosts: [...hosts], allowed_binding_types: ['http'] })]);
    if (g.code !== 0) throw new Error('1Claw refused to allow this API host for the agent.');
    writeFileSync(hostsFile, JSON.stringify([...hosts]));
  }
  const tmp = join(cfgDir, `.incoming-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, `DD_INCOMING=${apiKey}\n`, { mode: 0o600 });
  try {
    const config = { base_url: `https://${host}` };
    if (header !== 'bearer') Object.assign(config, { auth_type: 'header', auth_header: header });
    let r = await oneclaw(['agent', 'binding', 'create', agent, '--name', binding, '--type', 'http', '--config', JSON.stringify(config),
      '--guardrails', JSON.stringify({ allowed_hosts: [host] }), '--credential-from-env', 'DD_INCOMING', '--env-file', tmp]);
    if (/401|re-authenticate/.test(r.out)) throw new Error('This server is signed out of 1Claw, so the key was not stored or used. The host needs to run `1claw login`.');
    if (r.code !== 0) {
      // The binding exists from an earlier run: replace its credential.
      const list = await oneclaw(['agent', 'binding', 'list', agent, '--json']);
      const id = JSON.parse(list.out.slice(list.out.indexOf('['), list.out.lastIndexOf(']') + 1) || '[]').find((b) => b.name === binding)?.id;
      if (!id) throw new Error('1Claw could not create a binding for this key.');
      r = await oneclaw(['agent', 'binding', 'rotate-credential', agent, id, '--credential-from-env', 'DD_INCOMING', '--env-file', tmp]);
      if (r.code !== 0) throw new Error('1Claw could not store this key.');
    }
  } finally {
    writeFileSync(tmp, '');
    unlinkSync(tmp);
  }
}

async function startRun({ url, apiKey, maxApi }) {
  let site;
  try { site = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { throw new Error('That does not look like a web address.'); }
  site = site.origin;
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + randomBytes(2).toString('hex');
  const job = { runId, site, phase: 'reading', error: null, name: null };
  jobs.set(runId, job);

  (async () => {
    let pages = await pagesFromLlmsFull(site).catch(() => null);
    job.source = 'llms-full.txt';
    if (!pages && process.env.CONTEXT_DEV_API_KEY) {
      job.source = 'context.dev';
      pages = await pagesFromContextDev(site, process.env.CONTEXT_DEV_API_KEY, { limit: 60 });
    }
    if (!pages?.length) throw new Error('Could not read these docs: no llms-full.txt at that address, and no crawler key on this server.');
    const blocks = blocksFromPages(pages);
    const target = autoTarget(site, blocks);
    const name = `auto-${target.slug}`;
    Object.assign(job, { name, detected: target.detected, pages: pages.length, samples: blocks.length });
    mkdirSync(join(root, 'data', name), { recursive: true });
    writeFileSync(join(root, 'data', name, 'blocks.json'), JSON.stringify(blocks));
    writeFileSync(join(root, 'targets', `${name}.json`), JSON.stringify(target, null, 2));

    const flags = { runId, concurrency: 3, 'max-api': maxApi ?? 40 };
    if (apiKey && VAULT) {
      if (!target.vault) throw new Error('These docs do not show which API host the key is for, so the key was not stored or used.');
      job.phase = 'vault';
      await storeKey(target, apiKey);
      apiKey = null;
      flags.vault = true;
    } else if (apiKey) {
      // No vault: the key stays in this process and is written into the sandboxes for the run.
      if (!target.env[0]) throw new Error('These docs do not show which variable holds the key, so the key was not used.');
      process.env[target.env[0]] = apiKey;
      apiKey = null;
      job.keyed = true;
    } else {
      flags.kinds = 'setup,local'; // without a key, only run what needs none
    }
    job.phase = 'running';
    const plan = blocks.map((b) => {
      const c = classify(b, target);
      if (!flags.vault && !job.keyed && c.kind === 'api') return { ...b, ...c, kind: 'needs-key', reason: 'Calls the API. Add a key to run it.' };
      return { ...b, ...c };
    });
    await run({ root, target, targetName: name, plan, flags });
    job.phase = 'done';
  })().catch((e) => { job.phase = 'error'; job.error = String(e.message ?? e).replace(/(ocv_|ddp_)[\w-]+/g, '<hidden>').slice(0, 300); });
  return job;
}

/** The vault setup for a run, read live from 1Claw. Only configuration: 1Claw never returns the credential. */
async function vaultInfo(target) {
  const agentId = process.env.ONECLAW_AGENT_ID;
  const parse = (out) => { try { return JSON.parse(out.slice(out.indexOf('{'))); } catch { return null; } };
  const [b, a] = await Promise.all([
    oneclaw(['agent', 'binding', 'list', agentId, '--json']),
    oneclaw(['agent', 'get', agentId, '--json']),
  ]);
  const binding = parse(b.out)?.bindings?.find((x) => x.name === target.vault.binding);
  const agent = parse(a.out);
  if (!binding || !agent) return { available: false, reason: 'Could not read the configuration from 1Claw just now.' };
  return {
    available: true,
    provider: '1Claw',
    binding: {
      name: binding.name, type: binding.binding_type, baseUrl: binding.config?.base_url, allowedHosts: binding.guardrails?.allowed_hosts ?? [],
      credentialSet: binding.credential_set, credentialSource: binding.credential_source_type, active: binding.is_active, updatedAt: binding.updated_at,
      sentAs: target.vault.header === 'bearer' ? 'Authorization: Bearer <key>' : `${target.vault.header}: <key>`,
    },
    agent: {
      name: agent.name, id: agent.id, keyExpiresAt: agent.api_key_expires_at, allowedHosts: agent.execution_guardrails?.allowed_hosts ?? [],
      allowedBindingTypes: agent.execution_guardrails?.allowed_binding_types ?? [], canSign: agent.intents_api_enabled, modelProxy: agent.shroud_enabled,
    },
  };
}

/** A run from before this server started: rebuild its job record from what is on disk. */
function fromDisk(runId) {
  const runsDir = join(root, 'runs');
  for (const name of existsSync(runsDir) ? readdirSync(runsDir) : []) {
    const file = join(runsDir, name, runId, 'results.json');
    if (!existsSync(file) || !existsSync(join(root, 'targets', `${name}.json`))) continue;
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const target = JSON.parse(readFileSync(join(root, 'targets', `${name}.json`), 'utf8'));
    const job = { runId, name, site: state.site, phase: state.finishedAt ? 'done' : 'error', error: state.finishedAt ? null : 'This run was interrupted.',
      detected: target.detected ?? null, samples: Object.keys(state.samples).length, pages: new Set(Object.values(state.samples).map((s) => s.url)).size };
    jobs.set(runId, job);
    return job;
  }
  return null;
}

function readState(job) {
  const file = join(root, 'runs', job.name ?? '-', job.runId, 'results.json');
  if (!job.name || !existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname.startsWith('/r/'))) return send(res, 200, readFileSync(join(root, 'web/index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/api/config') return send(res, 200, { vault: VAULT });
    if (req.method === 'POST' && u.pathname === '/api/runs') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 20_000) return send(res, 413, { error: 'Too large.' }); }
      const { url, apiKey, maxApi } = JSON.parse(body || '{}');
      if (!url) return send(res, 400, { error: 'Enter the address of your docs.' });
      const job = await startRun({ url: String(url).trim(), apiKey: apiKey ? String(apiKey).trim() : null, maxApi: maxApi ? Math.min(Number(maxApi), 300) : undefined });
      return send(res, 200, { runId: job.runId });
    }
    const v = u.pathname.match(/^\/api\/runs\/([\w-]+)\/vault$/);
    if (req.method === 'GET' && v) {
      const job = jobs.get(v[1]) ?? fromDisk(v[1]);
      if (!job?.name) return send(res, 404, { error: 'No such run on this server.' });
      const target = JSON.parse(readFileSync(join(root, 'targets', `${job.name}.json`), 'utf8'));
      if (!readState(job)?.vault) return send(res, 200, { available: false, reason: 'This run used no API key, so nothing was put in a vault.' });
      return send(res, 200, await vaultInfo(target));
    }
    const m = u.pathname.match(/^\/api\/runs\/([\w-]+)(?:\/sample\/(\w+))?$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]) ?? fromDisk(m[1]);
      if (!job) return send(res, 404, { error: 'No such run on this server.' });
      const state = readState(job);
      let target = null;
      if (job.name) target = JSON.parse(readFileSync(join(root, 'targets', `${job.name}.json`), 'utf8'));
      if (m[2]) {
        const s = state?.samples[m[2]];
        if (!s) return send(res, 404, { error: 'No such sample.' });
        rejudge(s, target);
        const castFile = s.cast && join(root, 'runs', job.name, job.runId, s.cast);
        return send(res, 200, { ...s, cast: castFile && existsSync(castFile) ? readFileSync(castFile, 'utf8') : null });
      }
      const samples = Object.values(state?.samples ?? {}).map((s) => {
        rejudge(s, target);
        return { id: s.id, url: s.url, heading: s.heading, lang: s.runtime ?? s.lang, verdict: s.verdict, kind: s.kind, runnable: RUN_KINDS.has(s.kind) };
      });
      return send(res, 200, {
        runId: job.runId, site: job.site, phase: job.phase, error: job.error, detected: job.detected ?? null, source: job.source ?? null,
        pages: job.pages ?? null, total: job.samples ?? null, vault: state?.vault ?? null, environment: state?.environment ?? null,
        machines: new Set((state?.setups ?? []).map((x) => x.url)).size, samples,
      });
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    send(res, 400, { error: String(e.message ?? e).slice(0, 300) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`doc-doctor on http://127.0.0.1:${PORT}`));
