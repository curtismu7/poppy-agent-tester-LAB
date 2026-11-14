// Minimal TLS pass-through: LOCAL_PORT -> UPSTREAM_HOST:UPSTREAM_PORT, SNI untouched.
// Used by the poppy-agent-tester compose so the agent can reach the demo Company by
// the name its certificate and poppy.json use, from inside the Docker network.
import https from 'node:https';
import net from 'node:net';

const port = Number(process.env.LISTEN_PORT);
const upstreamHost = process.env.UPSTREAM_HOST;
const upstreamPort = Number(process.env.UPSTREAM_PORT || 443);
const tls = {
  cert: fs0(process.env.SHIM_CERT),
  key: fs0(process.env.SHIM_KEY),
};
import fs from 'node:fs';
function fs0(p) { return fs.readFileSync(p); }

https.createServer(tls, (clientReq, clientRes) => {
  const up = https.request({
    host: upstreamHost, port: upstreamPort, path: clientReq.url, method: clientReq.method,
    headers: clientReq.headers, rejectUnauthorized: false,
  }, (upRes) => { clientRes.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(clientRes); });
  up.on('error', () => { if (!clientRes.headersSent) clientRes.writeHead(502); clientRes.end(); });
  clientReq.pipe(up);
}).listen(port, '::', () => console.log(`[pass-tls] [::]:${port} -> ${upstreamHost}:${upstreamPort}`));
