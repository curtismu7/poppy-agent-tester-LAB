// The agent's long-lived signing key, published at /jwks.json. It is kept in a file so a restart does not change the key
// PingFederate has cached for the client metadata URL (it caches for at least five minutes). The file is private (mode 600).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateEs256Key, jwkThumbprint } from './jose.js';

export function loadAgentKey(dir) {
  const file = path.join(dir, 'agent-key.json');
  let privateJwk;
  try { privateJwk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (!privateJwk?.d) {
    privateJwk = generateEs256Key().privateJwk;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(privateJwk), { mode: 0o600 });
  }
  const { d, ...publicJwk } = privateJwk; // eslint-disable-line no-unused-vars
  return { privateKey: crypto.createPrivateKey({ key: privateJwk, format: 'jwk' }), publicJwk, kid: jwkThumbprint(publicJwk) };
}
