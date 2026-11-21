// Decide, for each code block, whether it can be run as published and how.
//
// A sample is only run when a reader could paste it and expect it to work:
// a known language, complete on its own, no values the reader must fill in,
// and nothing that deletes or cancels. Everything else is skipped with a reason,
// because a red tile must mean "the docs are wrong", never "we guessed badly".

const RUNTIMES = {
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', curl: 'bash',
  typescript: 'typescript', ts: 'typescript',
  javascript: 'javascript', js: 'javascript', mjs: 'javascript',
  python: 'python', py: 'python',
  go: 'go', golang: 'go',
  ruby: 'ruby', rb: 'ruby',
  php: 'php',
};

const DATA = new Set(['', 'json', 'jsonc', 'text', 'txt', 'yaml', 'yml', 'http', 'xml', 'html', 'csv',
  'markdown', 'md', 'mdx', 'mermaid', 'dotenv', 'env', 'toml', 'ini', 'diff', 'sql', 'css', 'plaintext', 'output']);

// Commands a fresh Linux machine can run with no account and no prompt.
const SHELL_OK = new Set(['curl', 'npm', 'npx', 'node', 'pip', 'pip3', 'python', 'python3', 'gem', 'ruby', 'go',
  'composer', 'php', 'export', 'echo', 'cat', 'mkdir', 'cd', 'jq', 'source', '.', 'ls', 'touch', 'uv', 'bun', 'tsx']);

const DESTRUCTIVE = /--request\s+DELETE|-X\s*DELETE|\bDELETE\s+\/|\.delete\(|->delete\(|\.Delete\(|\.del\(|\bcancel|\brotate|uninstall|\brm\s+-r/i;
const INSTALL = /\b(npm (install|i|add)|pnpm add|yarn add|bun add|pip3? install|uv (add|pip install)|gem install|go get|go mod init|composer require|python3? -m (venv|pip install))\b/;
const ELISION = /^\s*(\.\.\.|…|\/\/ ?\.\.\.|# ?\.\.\.)\s*$/m;

function selfContained(runtime, code) {
  switch (runtime) {
    case 'bash': return true;
    case 'typescript':
    case 'javascript': return /^\s*import\s|\brequire\(/m.test(code);
    case 'python': return /^\s*(import|from)\s/m.test(code) && !/^\s*await\s|=\s*await\s/m.test(code.replace(/async def[\s\S]*/, ''));
    case 'go': return /^package main\b/m.test(code) && /func main\(\)/.test(code);
    case 'ruby': return /^\s*require\s/m.test(code);
    case 'php': return /<\?php/.test(code);
    default: return false;
  }
}

function envVars(code) {
  const names = new Set();
  const re = /(?:process\.env\.|environ(?:\.get)?[\[(]\s*["']|ENV(?:\.fetch\(|\[)\s*["']|getenv\(\s*["']|Getenv\(\s*["']|\$\{?)([A-Z][A-Z0-9_]{2,})/g;
  for (const m of code.matchAll(re)) names.add(m[1]);
  return [...names];
}

/** Commands a shell sample calls that must already exist on the machine (not ones it brings in itself). */
export function prerequisites(code) {
  const cmds = new Set(shellCommands(code).filter((c) => !['export', 'cd', 'echo', 'source', '.', 'set', 'done', 'fi', 'EOF'].includes(c)));
  // After activating a virtual environment, python and pip come from it.
  if (/\bactivate\b/.test(code)) { cmds.delete('python'); cmds.delete('pip'); }
  return [...cmds];
}

function shellCommands(code) {
  return code
    .replace(/\\\n/g, ' ')
    .replace(/'[^']*'/gs, "''")
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^(\w+=\S*\s+)+/, '').split(/\s+/)[0])
    .filter((w) => /^[\w.\/-]+$/.test(w));
}

/**
 * @returns {{ kind: string, runtime?: string, reason?: string, creates?: boolean, estimate?: number }}
 *   kind is one of: api, local, setup (all three are run), or
 *   output, unsupported, destructive, needs-input, needs-tool, fragment (skipped).
 */
export function classify(block, target) {
  const code = block.code;
  if (DATA.has(block.lang)) return { kind: 'output', reason: 'Example output or data, not a program.' };
  const runtime = RUNTIMES[block.lang];
  if (!runtime) return { kind: 'unsupported', reason: `No runner for "${block.lang}" yet.` };

  const skipPage = (target.skipPages ?? []).find((p) => block.url.includes(p.match));
  if (skipPage) return { kind: 'needs-tool', runtime, reason: skipPage.reason };

  const callsApi = target.apiPatterns.some((p) => new RegExp(p).test(code));
  if (DESTRUCTIVE.test(code)) return { kind: 'destructive', runtime, reason: 'Deletes, cancels or rotates something; never run automatically.' };

  const placeholders = (target.placeholderPatterns ?? []).map((p) => code.match(new RegExp(p))?.[0]).filter(Boolean);
  if (placeholders.length) return { kind: 'needs-input', runtime, reason: `Contains a value the reader must replace: ${placeholders[0]}` };
  if (ELISION.test(code)) return { kind: 'fragment', runtime, reason: 'Part of the code is elided with "...".' };

  const foreign = envVars(code).filter((n) => !target.env.includes(n) && !(n in (target.extraEnv ?? {})) && !['HOME', 'PATH', 'PWD', 'USER'].includes(n));
  if (foreign.length) return { kind: 'needs-input', runtime, reason: `Needs another credential or value: ${foreign[0]}` };

  if (runtime === 'bash') {
    const unknown = shellCommands(code).filter((c) => !SHELL_OK.has(c));
    if (/\b(npm|pnpm|yarn|bun) (ci|run|test|start)\b/.test(code)) return { kind: 'needs-input', runtime, reason: "Runs a script from the reader's own project." };
    if (unknown.length) return { kind: 'needs-tool', runtime, reason: target.toolReasons?.[unknown[0]] ?? `Needs a tool or account outside a fresh machine: ${unknown[0]}` };
    if (target.readOnly && /(-X|--request)\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data|--data-raw|--json|-F|--form)\s/.test(code)) {
      return { kind: 'mutates', runtime, reason: 'Changes something on the account. This run used a read-only key, so it was not sent.' };
    }
    const file = code.match(/^\s*(?:python3?|node|ruby|php|npx tsx|tsx|go run)\s+([\w.\/-]+\.\w+)/m);
    if (file) return { kind: 'needs-input', runtime, reason: `Needs a file from another step: ${file[1]}` };
    if (/\b(login|auth)\b/.test(code) && !callsApi) return { kind: 'needs-tool', runtime, reason: 'Interactive sign-in.' };
  }
  if (runtime !== 'bash' && target.clientUse && new RegExp(target.clientUse).test(code) && !new RegExp(target.clientInit).test(code)) {
    return { kind: 'fragment', runtime, reason: 'Uses a client or an id that an earlier sample on the page defines.' };
  }
  if (!selfContained(runtime, code)) return { kind: 'fragment', runtime, reason: 'Not a complete program on its own (no imports or entry point).' };

  if (runtime === 'bash' && INSTALL.test(code) && !/\bcurl\b/.test(code)) return { kind: 'setup', runtime };
  if (!callsApi) {
    if (runtime === 'bash') return { kind: 'local', runtime };
    return { kind: 'local', runtime };
  }

  const creates = (target.createsPatterns ?? []).some((p) => new RegExp(p).test(code));
  let estimate = target.defaultEstimate ?? 1;
  for (const [pattern, credits] of target.estimates ?? []) {
    if (new RegExp(pattern, 'i').test(code)) { estimate = credits; break; }
  }
  return { kind: 'api', runtime, creates, estimate };
}

export const RUN_KINDS = new Set(['api', 'local', 'setup']);

const MISSING_FILE = /ENOENT|No such file or directory|FileNotFoundError|Failed to open stream|cannot find the file|open [\w.\/-]+: no such file/i;

/** Second look at a failed sample: was it the docs, or something the runner should not have judged? */
export function rejudge(sample, target) {
  if (!['fail', 'timeout'].includes(sample.verdict)) return;
  const tail = sample.tail ?? '';
  const now = classify(sample, target);
  if (!RUN_KINDS.has(now.kind)) return Object.assign(sample, { verdict: 'skipped', kind: now.kind, reason: now.reason });
  if ((target.interferencePatterns ?? []).some((p) => new RegExp(p).test(tail))) {
    return Object.assign(sample, { verdict: 'interfered', reason: 'Collided with state left by the same sample in another language. A reader runs one language, so this is not judged.' });
  }
  // The machine lacked something the docs take for granted. That is about the machine, not the sample.
  const notFound = tail.match(/(?:line \d+: )?([\w.+-]+): (?:command )?not found/);
  if (sample.exit === 127 && notFound) {
    return Object.assign(sample, { verdict: 'environment', reason: `Missing prerequisite: the machine has no \`${notFound[1]}\` command. The docs assume it is installed.` });
  }
  if (/externally-managed-environment/.test(tail)) {
    return Object.assign(sample, { verdict: 'environment', reason: 'The system Python refuses package installs outside a virtual environment (PEP 668, the default on Debian, Ubuntu and Homebrew). The command works inside a venv.' });
  }
  // A sample that leans on a variable from an earlier sample is a fragment, not a broken program.
  const undef = tail.match(/NameError: name '(\w+)' is not defined|ReferenceError: (\w+) is not defined|Cannot find name '(\w+)'|undefined local variable or method [`'](\w+)'|undefined: (\w+)|Undefined variable \$(\w+)/);
  if (undef && !/require is not defined/.test(tail)) {
    const name = undef.slice(1).find(Boolean);
    return Object.assign(sample, { verdict: 'skipped', kind: 'fragment', reason: `Uses \`${name}\`, which an earlier sample on the page defines. Not a whole program, so not judged.` });
  }
  const noModule = tail.match(/ModuleNotFoundError: No module named '([\w.]+)'|Cannot find (?:module|package) '([^']+)'/);
  if (noModule) {
    return Object.assign(sample, { verdict: 'skipped', kind: 'needs-input', reason: `Imports \`${noModule[1] ?? noModule[2]}\`, a package outside the SDK install these docs give. Not judged.` });
  }
  if (/require is not defined in ES module scope/.test(tail)) {
    return Object.assign(sample, { verdict: 'skipped', kind: 'unsupported', reason: 'A CommonJS sample; the runner saved it as an ES module. Runner limitation, not judged.' });
  }
  if ((target.planPatterns ?? []).some((p) => new RegExp(p, 'i').test(tail))) {
    return Object.assign(sample, { verdict: 'plan', reason: target.refusedReason ?? 'The API refused this for the account plan, not for the code.' });
  }
  if (MISSING_FILE.test(tail) || (sample.runtime === 'bash' && sample.exit === 26)) {
    return Object.assign(sample, { verdict: 'skipped', kind: 'needs-input', reason: 'Reads a local file the reader has to supply.' });
  }
}
