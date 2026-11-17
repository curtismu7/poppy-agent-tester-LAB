// The one-command launcher (scripts/install.sh) and its instructions. Nothing here starts a container or touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const script = path.join(root, 'scripts/install.sh');
const sh = (...args) => spawnSync('sh', [script, ...args], { encoding: 'utf8' });
const tmpDir = () => path.join(os.tmpdir(), `pat-install-test-${process.pid}-${Math.random().toString(36).slice(2)}`);

test('install.sh is valid sh and executable', () => {
  assert.equal(spawnSync('sh', ['-n', script]).status, 0);
  assert.ok(fs.statSync(script).mode & 0o111, 'executable bit');
});

test('--help lists the options and the pipe form', () => {
  const r = sh('--help');
  assert.equal(r.status, 0);
  for (const w of ['--real', '--mock', '--port', '--dir', '--runtime', '--no-open', '--dry-run', '--stop', 'curl -fsSL']) assert.match(r.stdout, new RegExp(w.replace(/[-]/g, '\\-')));
});

test('dry run in mock mode: loopback only, hardened container, MODE=mock, nothing created', () => {
  const dir = tmpDir();
  const r = sh('--dry-run', '--no-open', '--runtime', 'docker', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-e MODE=mock/);
  assert.match(r.stdout, /-p 127\.0\.0\.1:54\d\d:5450/);
  assert.match(r.stdout, /--read-only --cap-drop ALL --security-opt no-new-privileges:true/);
  assert.doesNotMatch(r.stdout, /--env-file/);
  assert.match(r.stdout, /Dry run: nothing was started/);
  assert.equal(fs.existsSync(dir), false, 'dry run must not create the directory');
});

test('dry run with --real: live mode, reads .env, still loopback only', () => {
  const dir = tmpDir();
  const r = sh('--dry-run', '--real', '--no-open', '--runtime', 'docker', '--dir', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-e MODE=live/);
  assert.match(r.stdout, new RegExp(`--env-file ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.env`));
  assert.match(r.stdout, /cp .*\.env\.example .*\.env/);
  assert.match(r.stdout, /-p 127\.0\.0\.1:/);
  assert.equal(fs.existsSync(dir), false);
});

test('dry run on the node runtime starts npm start with MODE and PORT', () => {
  const r = sh('--dry-run', '--no-open', '--runtime', 'node', '--dir', tmpDir());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PORT=54\d\d MODE=mock npm start/);
});

test('the docker run publishes only on 127.0.0.1', () => {
  const text = fs.readFileSync(script, 'utf8');
  const run = text.match(/runq docker run[\s\S]*?"\$NAME"\n/);
  assert.ok(run, 'docker run command found');
  const publishes = run[0].match(/-p "[^"]+"/g) || [];
  assert.equal(publishes.length, 1);
  assert.match(publishes[0], /127\.0\.0\.1:/);
});

test('rejects a port outside 5450-5499, a bad runtime and an unknown option', () => {
  assert.notEqual(sh('--dry-run', '--port', '6000').status, 0);
  assert.notEqual(sh('--dry-run', '--port', 'abc').status, 0);
  assert.notEqual(sh('--dry-run', '--runtime', 'podman').status, 0);
  assert.notEqual(sh('--bogus').status, 0);
});

test('README carries the instructions section and the PDF is built from it', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /<!-- instructions:start -->[\s\S]*curl -fsSL[\s\S]*<!-- instructions:end -->/);
  assert.match(readme, /PingOne cannot be the authorization server/);
  const pdf = fs.readFileSync(path.join(root, 'docs/Poppy-Agent-Tester-Setup.pdf'));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 20000);
});
