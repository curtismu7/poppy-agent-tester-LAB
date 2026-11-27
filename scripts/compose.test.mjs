import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { portProblem } from '../server/src/safety.js';

// Every published port must be bound to loopback on the host. A small line parser (no YAML dependency).
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}
const here = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('docker-compose.yml publishes only on 127.0.0.1', () => {
  const ports = publishedPorts(here('docker-compose.yml'));
  assert.ok(ports.length > 0, 'the parser found the published port');
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, `${p} must start with 127.0.0.1:`);
});

test('the parser flags an unbound or wildcard publish', () => {
  for (const bad of ['- "5450:5450"', '- "0.0.0.0:5450:5450"', '- 5450', '- "::1:5450:5450"']) {
    const ports = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(ports.length, 1);
    assert.doesNotMatch(ports[0], /^127\.0\.0\.1:/);
  }
});

test('compose default host port and container port are allowed ports and agree', () => {
  const compose = here('docker-compose.yml');
  const host = Number(/\$\{HOST_PORT:-(\d+)\}/.exec(compose)[1]);
  assert.equal(portProblem(host), null);
  // The server serves the API page and the public TLS identity on ONE container port
  // (PAT_TLS_CERT set => https). The agent URL names 5451, so the container port is 5451,
  // published on loopback host ports 5450 (page via the family port) and 5451 (the agent URL).
  const container = Number(/:\d+:(\d+)"/.exec(compose)[1]);
  assert.equal(portProblem(container), null);
  assert.equal(container, 5451);
  assert.match(compose, /"127\.0\.0\.1:5451:5451"/);
  assert.match(compose, /NODE_EXTRA_CA_CERTS/);
  assert.match(here('Dockerfile'), /^USER node$/m);
});

test('the container is locked down: read-only fs, no capabilities, no new privileges', () => {
  const compose = here('docker-compose.yml');
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
});

test('docker-compose.yml allows the family lab-proxy name by default, never the bare launcher name', () => {
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /LAB_ALLOWED_HOSTS: \$\{LAB_ALLOWED_HOSTS:-poppy-demo\.local\.ping-devops\.com\}\n/);
  assert.doesNotMatch(compose, /LAB_ALLOWED_HOSTS:[^\n]*[-,]local\.ping-devops\.com\b/);
});

// The Company origin is answered by company-shim on 127.0.0.1 inside the agent's network, so its host name must resolve to loopback there.
test('docker-compose.yml maps the Company origin host name to loopback for the agent', () => {
  const text = here('docker-compose.yml');
  assert.match(text, /extra_hosts:\s*\n\s*-\s*"\$\{PAT_DEMO_COMPANY_HOST:-localhost\}:127\.0\.0\.1"/);
  assert.match(here('.env.example'), /PAT_DEMO_COMPANY_HOST/);
});
