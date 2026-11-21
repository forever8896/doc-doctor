// Sandbox-local TLS front for the API host. It only forwards to the 1Claw binding proxy on localhost,
// so published samples keep calling https://<api host> unchanged while the real key stays in the vault.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const [, , certDir, target = 'http://127.0.0.1:8787'] = process.argv;
const upstream = new URL(target);
https
  .createServer({ key: readFileSync(`${certDir}/host.key`), cert: readFileSync(`${certDir}/host.crt`) }, (req, res) => {
    const out = http.request(
      { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
    );
    out.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'vault_proxy_unreachable', detail: e.message })); });
    req.pipe(out);
  })
  .listen(443, '127.0.0.1');
