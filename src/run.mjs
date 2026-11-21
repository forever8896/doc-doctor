// Run the plan: one fresh Boat sandbox per docs page, one recorded terminal session per sample.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSandbox, exec, copyOut, destroy } from './boat.mjs';
import { RUN_KINDS, rejudge, prerequisites } from './classify.mjs';

const SNAPSHOT = 'doc-doctor-base';
const VAULT_SNAPSHOT = 'doc-doctor-vault';
const FILES = { typescript: 'example.mts', javascript: 'example.mjs', python: 'example.py', ruby: 'example.rb', go: 'main.go', php: 'example.php', bash: 'sample.sh' };
const RUNS = {
  typescript: 'npx tsx example.mts',
  javascript: 'node example.mjs',
  python: 'python example.py',
  ruby: 'ruby example.rb',
  go: 'go run main.go',
  php: 'php example.php',
};
const PROMPT = '\x1b[38;5;42m$\x1b[0m ';

// ── scripts that live in the sandbox ────────────────────────────────────────
const RUN_SH = `#!/bin/bash
# Record one job as a terminal session and print a one-line JSON result.
id=$1; cd ~/dd; mkdir -p out; : > /tmp/dd_http; rm -f out/$id.exit
start=$(date +%s%3N)
TERM=xterm-256color asciinema rec -q --overwrite --cols 110 --rows 30 -c "bash $HOME/dd/wrap.sh $id" out/$id.cast >/dev/null 2>&1
end=$(date +%s%3N)
python3 ~/dd/result.py $id $((end-start))
`;
const WRAP_SH = `#!/bin/bash
id=$1; . ~/dd/meta/$id.env
mkdir -p ~/dd/$DIR; cd ~/dd/$DIR
set -a; . ~/dd/.key; set +a
export PATH=$HOME/dd/bin:$PATH TERM=xterm-256color
# With a vault, the API host resolves to this machine; trust the sandbox's own certificate authority.
if [ -f ~/ddvault/ca.crt ] && [ -f ~/dd/.proxy-token ]; then export NODE_EXTRA_CA_CERTS=$HOME/ddvault/ca.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt; fi
[ -n "$PRE" ] && eval "$PRE"
cat ~/dd/meta/$id.show
# No keyboard: this is an unattended machine, like CI. A command that asks a question gets no answer.
timeout -k 5 $TIMEOUT bash ~/dd/cmd/$id.sh < /dev/null
echo $? > ~/dd/out/$id.exit
`;
// A curl in front of the real one that notes each HTTP status, so a 4xx body is not counted as a pass.
const CURL_SH = `#!/bin/bash
for a in "$@"; do case "$a" in -w|--write-out|--write-out=*) exec /usr/bin/curl "$@";; esac; done
exec /usr/bin/curl "$@" --write-out '%output{>>/tmp/dd_http}%{http_code}\\n'
`;
const RESULT_PY = `import json, re, sys, os
id, ms = sys.argv[1], int(sys.argv[2])
home = os.path.expanduser('~/dd')
text = ''
try:
    for line in open(f'{home}/out/{id}.cast').read().split('\\n')[1:]:
        if line.startswith('['):
            ev = json.loads(line)
            if ev[1] == 'o': text += ev[2]
except Exception as e:
    text += f'[no recording: {e}]'
text = re.sub(r'\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][^\\x07]*\\x07|\\r', '', text)
try: code = int(open(f'{home}/out/{id}.exit').read().strip())
except Exception: code = 255
http = [int(x) for x in open('/tmp/dd_http').read().split() if x.isdigit()] if os.path.exists('/tmp/dd_http') else []
print(json.dumps({'exit': code, 'ms': ms, 'http': http, 'tail': text[-6000:]}))
`;

// ── helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (url) => new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'index';
const pick = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

function bundle(files) {
  let sh = '#!/bin/bash\nset -e\ncd ~/dd\n';
  for (const [path, content] of Object.entries(files)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    sh += `mkdir -p '${dir}'\nbase64 -d > '${path}' <<'DD_EOF'\n${Buffer.from(content).toString('base64')}\nDD_EOF\n`;
  }
  return sh + 'chmod +x bin/curl run.sh wrap.sh\necho bundle-ok\n';
}

function show(runtime, code) {
  if (runtime !== 'bash') return `${PROMPT}${RUNS[runtime]}\n`;
  return PROMPT + code.trimEnd() + '\n';
}

function jobFiles(job) {
  const files = {};
  if (job.setupFor) {
    files[`cmd/${job.id}.sh`] = 'set -e\n' + job.lines.join('\n') + '\n';
    files[`meta/${job.id}.env`] = `DIR=${job.setupFor}\nTIMEOUT=300\nPRE=\n`;
    files[`meta/${job.id}.show`] = job.lines.map((l) => PROMPT + l).join('\n') + '\n';
    return files;
  }
  const dir = `${job.runtime}/${job.id}`;
  files[`${dir}/${FILES[job.runtime]}`] = job.code;
  let pre = '';
  if (job.runtime === 'php') pre = 'ln -sfn ../vendor vendor';
  if (job.runtime === 'python') pre = 'source ../.venv/bin/activate';
  files[`cmd/${job.id}.sh`] = (job.runtime === 'bash' ? 'bash sample.sh' : RUNS[job.runtime]) + '\n';
  files[`meta/${job.id}.env`] = `DIR=${dir}\nTIMEOUT=${job.kind === 'setup' ? 300 : 150}\nPRE='${pre}'\n`;
  files[`meta/${job.id}.show`] = show(job.runtime, job.code);
  return files;
}

// ── the run ─────────────────────────────────────────────────────────────────
export async function run({ root, target, targetName, plan, flags }) {
  // With --vault the API key stays in 1Claw: this process and the sandboxes only hold a scoped agent key,
  // and every API call goes through a binding that injects the real credential server-side.
  const vault = flags.vault ? target.vault : null;
  const vaultEnv = join(process.env.HOME, '.config/doc-doctor/1claw.env');
  if (vault && !existsSync(vaultEnv)) throw new Error(`--vault needs ${vaultEnv} with ONECLAW_AGENT_ID and ONECLAW_AGENT_API_KEY.`);
  const key = vault ? null : process.env[target.env[0]];
  if (!vault && !key && (flags.kinds ?? 'api').includes('api')) throw new Error(`Set ${target.env[0]} (environment or ~/.config/doc-doctor/env), or use --vault.`);
  const localProxy = vault ? await startLocalProxy(vault, vaultEnv) : null;
  const budget = Number(flags.budget ?? 200);
  const maxEstimate = Number(flags['max-estimate'] ?? 20);
  const kinds = new Set((flags.kinds ?? 'setup,local,api').split(','));
  let apiRuns = 0;
  const maxApi = Number(flags['max-api'] ?? Infinity);
  const runId = flags.resume ?? flags.runId ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(root, 'runs', targetName, runId);
  mkdirSync(join(runDir, 'casts'), { recursive: true });
  const resultsFile = join(runDir, 'results.json');
  // Only this target's variables go into its sandboxes, never the whole key file.
  const keyFile = join(runDir, '.key');
  if (!vault) {
    const lines = target.env.filter((n) => process.env[n]).map((n) => `${n}=${process.env[n]}`);
    for (const [n, v] of Object.entries(target.extraEnv ?? {})) lines.push(`${n}=${v}`);
    writeFileSync(keyFile, lines.join('\n') + '\n', { mode: 0o600 });
  }
  const redact = (s) => {
    if (typeof s !== 'string') return s;
    if (key) s = s.split(key).join(`$${target.env[0]}`);
    return s.replace(/ddp_[a-f0-9]{32}/g, `$${target.env[0]}`).replace(/ocv_[A-Za-z0-9_-]+/g, '<agent key>');
  };

  const state = {
    target: target.name, site: target.site, runId, startedAt: new Date().toISOString(), finishedAt: null,
    budget, spent: 0, samples: {}, setups: [],
    vault: vault ? { provider: vault.provider, binding: vault.binding } : null,
  };
  if (flags.resume && existsSync(resultsFile)) Object.assign(state, JSON.parse(readFileSync(resultsFile, 'utf8')), { finishedAt: null });
  const save = () => writeFileSync(resultsFile, JSON.stringify(state, null, 1));

  // Watch mode: samples whose text has not changed keep their verdict and recording from the last run,
  // so only new or edited samples get a machine.
  if (flags.carryFrom && existsSync(join(flags.carryFrom, 'results.json'))) {
    const prev = JSON.parse(readFileSync(join(flags.carryFrom, 'results.json'), 'utf8'));
    const ids = new Set(plan.map((b) => b.id));
    state.changed = [];
    for (const [id, s] of Object.entries(prev.samples)) {
      if (!ids.has(id) || !['pass', 'fail', 'timeout', 'plan', 'environment', 'blocked', 'interfered'].includes(s.verdict)) continue;
      state.samples[id] = { ...s, carried: s.carried ?? prev.runId };
      const from = s.cast && join(flags.carryFrom, s.cast);
      if (from && existsSync(from)) writeFileSync(join(runDir, s.cast), readFileSync(from));
    }
    state.previousRun = prev.runId;
  }
  for (const b of plan) {
    if (state.samples[b.id]?.verdict && !['pending', 'running'].includes(state.samples[b.id].verdict)) continue;
    const runnable = RUN_KINDS.has(b.kind) && kinds.has(b.kind) && (!flags.only || b.url.includes(flags.only));
    state.samples[b.id] = {
      ...b,
      verdict: runnable ? 'pending' : RUN_KINDS.has(b.kind) ? 'not-selected' : 'skipped',
    };
  }
  let todo = Object.values(state.samples).filter((s) => s.verdict === 'pending');
  if (state.changed) state.changed = todo.map((s) => s.id);
  if (flags.max) {
    for (const s of todo.slice(Number(flags.max))) s.verdict = 'not-selected';
    todo = todo.slice(0, Number(flags.max));
  }
  save();

  // usage + cleanup against the docs' own API
  const api = async (method, url) => {
    const res = localProxy
      ? await fetch(url.replace(`https://${vault.host}`, localProxy.url), { method, headers: { Authorization: `Bearer ${localProxy.token}` } })
      : await fetch(url, { method, headers: { Authorization: `Bearer ${key}` } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const consumed = async () => {
    if (!target.usage) return 0; // this API has no credits to meter
    for (let i = 0; i < 4; i++) {
      const r = await api('GET', target.usage.url);
      const v = pick(r.json, target.usage.remainingPath);
      if (typeof v === 'number') return -v; // credits left, negated: it grows as credits are spent
      await sleep(5000);
    }
    throw new Error('Could not read usage; stopping so the budget is not exceeded.');
  };
  const listIds = async (c) => {
    const r = await api('GET', c.list);
    return (pick(r.json, c.items) ?? []).map((x) => x[c.id]);
  };
  const baseline = {};
  for (const c of target.cleanup ?? []) baseline[c.name] = new Set(await listIds(c));
  const cleanup = async () => {
    const removed = [];
    for (const c of target.cleanup ?? []) {
      for (const id of await listIds(c)) {
        if (baseline[c.name].has(id)) continue; // existed before the run: never touched
        const r = await api(c.delete[0], c.delete[1].replace('{id}', id));
        baseline[c.name].add(id);
        removed.push(`${c.name}:${id}:${r.status}`);
      }
    }
    return removed;
  };

  const startConsumed = flags.resume ? (await consumed()) - state.spent : await consumed();
  let lock = Promise.resolve();
  const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
  let lastApiStart = 0;

  const pages = new Map();
  for (const s of todo) (pages.get(s.url) ?? pages.set(s.url, []).get(s.url)).push(s);
  const queue = [...pages.entries()].sort((a, b) => (b[0].endsWith('/quickstart') ? 1 : 0) - (a[0].endsWith('/quickstart') ? 1 : 0));
  console.log(`run ${runId}: ${todo.length} samples on ${queue.length} pages, budget ${budget} credits`);

  // ── preflight: is the machine what the docs assume? ──────────────────────
  // The target lists the prerequisites its docs take for granted; `provide` makes the sandbox match.
  // Then one sandbox checks every command the shell samples call, before anything is judged.
  const provide = (target.assumes ?? []).map((a) => a.provide).filter(Boolean).join(' && ');
  const needed = new Map();
  for (const s of todo.filter((s) => s.runtime === 'bash')) for (const c of prerequisites(s.code)) (needed.get(c) ?? needed.set(c, []).get(c)).push(s);
  if (needed.size && !flags['no-preflight']) {
    const box = await createSandbox({ name: 'dd-preflight', from: vault ? VAULT_SNAPSHOT : SNAPSHOT });
    try {
      const list = [...needed.keys()].filter((c) => /^[\w.+-]+$/.test(c));
      const r = await exec(box, `${provide ? provide + ' >/dev/null 2>&1; ' : ''}for c in ${list.join(' ')}; do command -v "$c" >/dev/null 2>&1 && echo "have $c" || echo "missing $c"; done; . /etc/os-release; echo "os $PRETTY_NAME"`, { timeout: 120 });
      const out = r.stdout ?? '';
      const missing = [...out.matchAll(/^missing (.+)$/gm)].map((m) => m[1]);
      state.environment = {
        os: out.match(/^os (.+)$/m)?.[1] ?? null,
        assumes: (target.assumes ?? []).map(({ command, note }) => ({ command, note })),
        checked: list, missing,
      };
      for (const c of missing) {
        for (const s of needed.get(c)) {
          if (s.verdict !== 'pending') continue;
          Object.assign(s, { verdict: 'environment', reason: `Missing prerequisite: the machine has no \`${c}\` command. The docs assume it is installed.` });
        }
      }
      todo = todo.filter((s) => s.verdict === 'pending');
      console.log(`preflight on ${state.environment.os}: ${list.length} commands checked, missing: ${missing.join(', ') || 'none'}`);
    } finally {
      await destroy(box).catch(() => {});
      save();
    }
    for (const [url, samples] of [...pages.entries()]) {
      const left = samples.filter((s) => s.verdict === 'pending');
      if (left.length) pages.set(url, left); else pages.delete(url);
    }
    queue.length = 0;
    queue.push(...[...pages.entries()].sort((a, b) => (b[0].endsWith('/quickstart') ? 1 : 0) - (a[0].endsWith('/quickstart') ? 1 : 0)));
  }

  async function runJob(box, id, timeout) {
    const r = await exec(box, `bash ~/dd/run.sh ${id}`, { timeout });
    try {
      return JSON.parse(redact((r.stdout ?? '').trim().split('\n').at(-1)));
    } catch {
      return { exit: 255, ms: 0, http: [], tail: redact(`[runner error] ${(r.stderr || r.stdout || '').slice(-500)}`) };
    }
  }

  function judge(s, r) {
    const badHttp = (r.http ?? []).find((c) => c >= 400);
    if (r.exit === 124 || r.exit === 137) return ['timeout', 'Did not finish in time.'];
    if (r.exit === 0 && !badHttp) return ['pass', null];
    if ((target.interferencePatterns ?? []).some((p) => new RegExp(p).test(r.tail))) return ['interfered', 'Collided with state left by the same sample in another language. A reader runs one language, so this is not judged.'];
    const plan = (target.planPatterns ?? []).find((p) => new RegExp(p, 'i').test(r.tail));
    if (plan) return ['plan', 'The API refused this for the account plan, not for the code.'];
    return ['fail', badHttp ? `The API answered HTTP ${badHttp}.` : `Exited with code ${r.exit}.`];
  }

  async function runPage(url, samples) {
    const name = `dd-${slug(url)}`.slice(0, 60);
    const runtimes = [...new Set(samples.map((s) => s.runtime))].filter((rt) => target.setup[rt]);
    const setups = runtimes.map((rt) => ({ id: `setup-${rt}`, setupFor: rt, lines: target.setup[rt] }));
    const files = { 'run.sh': RUN_SH, 'wrap.sh': WRAP_SH, 'bin/curl': CURL_SH, 'result.py': RESULT_PY };
    if (vault) {
      for (const f of ['tls.mjs', 'vault-start.sh']) files[`vault/${f}`] = readFileSync(join(root, 'sandbox', f), 'utf8');
    }
    for (const job of [...setups, ...samples]) Object.assign(files, jobFiles(job));
    const bundleFile = join(runDir, `bundle-${slug(url)}.sh`);
    writeFileSync(bundleFile, bundle(files));

    let box;
    try {
      box = await createSandbox({
        name, from: vault ? VAULT_SNAPSHOT : SNAPSHOT,
        files: vault
          ? { 'dd/bundle.sh': bundleFile, 'dd/.1claw': vaultEnv }
          : { 'dd/bundle.sh': bundleFile, 'dd/.key': keyFile },
      });
      const unpack = await exec(box, `${provide ? provide + ' >/dev/null 2>&1; ' : ''}bash ~/dd/bundle.sh`, { timeout: 120 });
      if (!/bundle-ok/.test(unpack.stdout ?? '')) throw new Error(`bundle failed: ${(unpack.stderr ?? '').slice(-300)}`);
      if (vault) {
        const v = await exec(box, `bash ~/dd/vault/vault-start.sh ${vault.host} ${vault.binding} && printf '${target.env[0]}=%s\\n' "$(cat ~/dd/.proxy-token)" > ~/dd/.key`, { timeout: 60 });
        if (!/vault-ok/.test(v.stdout ?? '')) throw new Error(`vault proxy did not start: ${redact((v.stdout ?? '') + (v.stderr ?? '')).slice(-300)}`);
      }
      for (const s of samples) s.sandbox = box;

      // Install each language's SDK the way the docs say to, in parallel.
      const failed = new Set();
      await Promise.all(setups.map(async (job) => {
        const r = await runJob(box, job.id, 330);
        const ok = r.exit === 0;
        if (!ok) failed.add(job.setupFor);
        state.setups.push({ url, runtime: job.setupFor, lines: job.lines, ok, ms: r.ms, tail: r.tail, cast: `casts/${slug(url)}--${job.id}.cast` });
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} setup ${job.setupFor.padEnd(10)} ${slug(url)} (${(r.ms / 1000).toFixed(1)}s)`);
        save();
      }));

      for (const s of samples) {
        if (failed.has(s.runtime)) {
          Object.assign(s, { verdict: 'blocked', reason: `The docs' own install command for ${s.runtime} failed on this machine.` });
          save();
          continue;
        }
        const body = async () => {
          if (s.kind === 'api') {
            if (s.estimate > maxEstimate) return Object.assign(s, { verdict: 'over-budget', reason: `Estimated at ${s.estimate} credits, above the per-sample cap of ${maxEstimate}.` });
            if (apiRuns >= maxApi) return Object.assign(s, { verdict: 'over-budget', reason: `This run was limited to ${maxApi} samples that call the API.` });
            apiRuns++;
            if (state.spent + s.estimate > budget) return Object.assign(s, { verdict: 'over-budget', reason: `The run's budget of ${budget} credits was reached.` });
            const gap = (target.minGapMs ?? 7000) - (Date.now() - lastApiStart);
            if (gap > 0) await sleep(gap);
          }
          s.verdict = 'running'; s.startedAt = new Date().toISOString(); save();
          let r;
          for (let attempt = 0; attempt < 3; attempt++) {
            lastApiStart = Date.now();
            r = await runJob(box, s.id, s.kind === 'setup' ? 330 : 190);
            const limited = (r.http ?? []).includes(429) || (r.exit !== 0 && /\b429\b|rate.?limit/i.test(r.tail));
            if (!limited || s.kind !== 'api') break;
            console.log(`  rate limited, waiting 65s (${s.id})`);
            await sleep(65_000);
          }
          const [verdict, reason] = judge(s, r);
          Object.assign(s, { verdict, reason, exit: r.exit, ms: r.ms, http: r.http, tail: r.tail, cast: `casts/${s.id}.cast` });
          rejudge(s, target);
          if (s.kind === 'api') {
            const now = (await consumed()) - startConsumed;
            s.credits = now - state.spent;
            state.spent = now;
            if (s.creates) s.cleaned = await cleanup();
          }
          console.log(`  ${s.verdict.padEnd(7)} ${s.runtime.padEnd(10)} ${slug(url)} ${s.heading ? '· ' + s.heading.slice(0, 40) : ''}${s.kind === 'api' ? ` [${s.credits}cr, total ${state.spent}]` : ''}`);
          save();
        };
        await (s.kind === 'api' ? serial(body) : body());
      }

      mkdirSync(join(runDir, `out-${slug(url)}`), { recursive: true });
      await copyOut(box, '/home/user/dd/out', join(runDir, `out-${slug(url)}`));
      const outDir = join(runDir, `out-${slug(url)}`, 'out');
      if (existsSync(outDir)) {
        for (const f of readdirSync(outDir).filter((f) => f.endsWith('.cast'))) {
          const dest = f.startsWith('setup-') ? `${slug(url)}--${f}` : f;
          writeFileSync(join(runDir, 'casts', dest), redact(readFileSync(join(outDir, f), 'utf8')));
        }
      }
      rmSync(join(runDir, `out-${slug(url)}`), { recursive: true, force: true });
    } catch (e) {
      console.log(`  page failed: ${slug(url)}: ${e.message}`);
      for (const s of samples) if (['pending', 'running'].includes(s.verdict)) Object.assign(s, { verdict: 'pending', reason: `Runner problem, not judged: ${redact(e.message).slice(0, 200)}` });
    } finally {
      rmSync(bundleFile, { force: true });
      if (box && !flags.keep) await destroy(box).catch(() => {});
      save();
    }
  }

  const workers = Array.from({ length: Number(flags.concurrency ?? 3) }, async () => {
    while (queue.length) {
      const [url, samples] = queue.shift();
      console.log(`page ${slug(url)} (${samples.length} samples)`);
      await runPage(url, samples);
    }
  });
  await Promise.all(workers);
  const leftovers = await cleanup().catch(() => []);
  if (leftovers.length) console.log(`cleaned up after the run: ${leftovers.join(', ')}`);
  state.finishedAt = new Date().toISOString();
  save();
  writeFileSync(keyFile, '');
  localProxy?.stop();

  const tally = {};
  for (const s of Object.values(state.samples)) tally[s.verdict] = (tally[s.verdict] ?? 0) + 1;
  console.log(`\ndone: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}; ${state.spent} credits spent\n${resultsFile}`);
  return runId;
}

/** Run `1claw agent binding proxy` on this machine for the orchestrator's own calls (usage, cleanup). */
async function startLocalProxy(vault, envFile) {
  const env = { ...process.env };
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const token = 'ddp_' + randomBytes(16).toString('hex');
  const port = 18000 + Math.floor(Math.random() * 2000);
  env.ONECLAW_PROXY_TOKEN = token;
  const child = spawn('1claw', ['agent', 'binding', 'proxy', vault.binding, '-p', String(port)], { env, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try { await fetch(url); return { url, token, stop: () => child.kill() }; } catch { await sleep(500); }
  }
  child.kill();
  throw new Error('The local 1Claw binding proxy did not start.');
}
