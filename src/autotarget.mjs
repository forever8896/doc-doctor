// Work out a target config from the docs themselves, so a docs URL is all a person has to give.
const top = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function autoTarget(site, blocks) {
  const hosts = {}, vars = {}, headers = {};
  const pk = { npm: {}, pip: {}, gem: {}, go: {}, composer: {} };
  for (const b of blocks) {
    const code = b.code;
    // Which variable holds the key, and how it is sent.
    for (const m of code.matchAll(/(Authorization|[Xx]-[\w-]*[Kk]ey|[\w-]*[Tt]oken)["']?\s*[:=]\s*["']?(Bearer |Token |Basic )?\$\{?([A-Z][A-Z0-9_]{2,})/g)) {
      vars[m[3]] = (vars[m[3]] ?? 0) + 3;
      headers[m[1].toLowerCase() === 'authorization' ? 'bearer' : m[1]] = (headers[m[1].toLowerCase() === 'authorization' ? 'bearer' : m[1]] ?? 0) + 1;
      for (const h of code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)) hosts[h[1]] = (hosts[h[1]] ?? 0) + 1;
    }
    for (const m of code.matchAll(/(?:process\.env\.|environ(?:\.get)?[\[(]\s*["']|ENV(?:\.fetch\(|\[)\s*["']|getenv\(\s*["']|Getenv\(\s*["'])([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)/g)) vars[m[1]] = (vars[m[1]] ?? 0) + 1;
    // What the docs tell the reader to install.
    for (const m of code.matchAll(/^\s*npm (?:install|i|add) (?!-)((?:@[\w.-]+\/)?[\w.-]+)\s*$/gm)) pk.npm[m[1]] = (pk.npm[m[1]] ?? 0) + 1;
    for (const m of code.matchAll(/^\s*(?:python3? -m )?pip3? install (?:-U )?(?!-)([\w.\[\]-]+)\s*$/gm)) pk.pip[m[1]] = (pk.pip[m[1]] ?? 0) + 1;
    for (const m of code.matchAll(/^\s*gem install ([\w.-]+)\s*$/gm)) pk.gem[m[1]] = (pk.gem[m[1]] ?? 0) + 1;
    for (const m of code.matchAll(/^\s*go get ([\w.\/@-]+)\s*$/gm)) pk.go[m[1]] = (pk.go[m[1]] ?? 0) + 1;
    for (const m of code.matchAll(/^\s*(composer require .+)$/gm)) pk.composer[m[1].trim()] = (pk.composer[m[1].trim()] ?? 0) + 1;
  }
  const docsHost = new URL(site).host;
  delete hosts[docsHost];
  const apiHost = top(hosts);
  const envVar = top(vars);
  const header = top(headers) ?? 'bearer';
  const [npm, pip, gem, go, composer] = [top(pk.npm), top(pk.pip), top(pk.gem), top(pk.go), top(pk.composer)];
  const setup = {};
  if (npm) { setup.typescript = [`npm install ${npm}`, 'npm install --save-dev tsx']; setup.javascript = [`npm install ${npm}`]; }
  if (pip) setup.python = ['python3 -m venv .venv', 'source .venv/bin/activate', `python -m pip install ${pip}`];
  if (gem) setup.ruby = [`gem install ${gem}`];
  if (go) setup.go = ['go mod init example.com/docs-sample', `go get ${go}`];
  if (composer) setup.php = [composer];

  const apiPatterns = [];
  if (apiHost) apiPatterns.push(esc(apiHost));
  if (envVar) apiPatterns.push(envVar);
  const slug = docsHost.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return {
    name: docsHost.replace(/^(docs|developers?|www)\./, ''),
    site, slug, auto: true,
    env: envVar ? [envVar] : [],
    apiPatterns: apiPatterns.length ? apiPatterns : ['a^'],
    placeholderPatterns: ['YOUR_[A-Z_]+', '<[a-zA-Z_-]+>', '\\b\\w+_(123|abc|xyz)\\w*', '/v\\d/[\\w/-]*\\{[a-z_]+\\}', '/path/to/', 'xxx+', '\\b\\w+_\\.\\.\\.'],
    defaultEstimate: 0, estimates: [], minGapMs: 6500,
    setup,
    assumes: [{ command: 'python', note: 'Python 3 available as python', provide: 'sudo ln -sf /usr/bin/python3 /usr/local/bin/python' }],
    planPatterns: ['paid plan', 'upgrade (your|to)', 'requires (a|the) .* plan'],
    vault: apiHost ? { provider: '1claw', binding: slug, host: apiHost, header } : null,
    detected: { apiHost, envVar, header, packages: { npm, pip, gem, go, composer } },
  };
}
