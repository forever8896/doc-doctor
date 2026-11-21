// Thin wrapper over the Boat CLI. Every call returns the last JSON object the CLI printed.
import { spawn } from 'node:child_process';

// The runner drives Boat with the signed-in CLI session. A BOAT_API_KEY in the environment belongs to the
// samples under test (it may be read-only), so it must not reach the CLI.
function cliEnv() {
  const env = { ...process.env };
  delete env.BOAT_API_KEY;
  return env;
}

export function boat(args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('boat', [...args, '--json', '--no-update'], { stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.trim().split('\n').filter((l) => l.startsWith('{'));
      let json = null;
      try { json = JSON.parse(lines.at(-1)); } catch { /* not JSON */ }
      resolve({ code, json, out, err });
    });
  });
}

/** Create a sandbox from a snapshot. `files` maps sandbox paths to local files. */
export async function createSandbox({ name, from, env = {}, files = {} }) {
  const args = ['new', '--name', name, '--no-env', '--ttl', '3600'];
  if (from) args.push('--from', from);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const [remote, local] of Object.entries(files)) args.push('--file', `${remote}=${local}`);
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await boat(args);
    last = (r.err || r.out).slice(-300);
    const id = r.json?.id ?? r.out.match(/"id":"(bx_[a-z0-9]+)"/)?.[1];
    if (id) {
      // The CLI can return before the machine is ready; wait for it rather than leaking it.
      for (let i = 0; i < 30; i++) {
        const info = await boat(['info', id]);
        const state = info.json?.state ?? info.json?.sandbox?.state;
        if (state === 'ready' || state === 'idle' || state === 'running') return id;
        await new Promise((res) => setTimeout(res, 4000));
      }
      await destroy(id).catch(() => {});
    }
    await new Promise((res) => setTimeout(res, 20_000 * (attempt + 1)));
  }
  throw new Error(`boat new failed: ${last}`);
}

export async function exec(id, command, { timeout = 60 } = {}) {
  const r = await boat(['exec', id, '--timeout', String(timeout), '--', 'bash', '-lc', command], {
    timeoutMs: (timeout + 60) * 1000,
  });
  return r.json ?? { exitCode: r.code ?? 1, stdout: r.out, stderr: r.err };
}

export async function copyOut(id, remoteDir, localDir) {
  const child = spawn('boat', ['scp', '-r', `${id}:${remoteDir}`, localDir, '--no-update'], { stdio: 'ignore', env: cliEnv() });
  return new Promise((resolve) => child.on('close', resolve));
}

export async function destroy(id) {
  await boat(['delete', id, '--yes']);
}
