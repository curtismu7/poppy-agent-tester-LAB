import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFrom, urlProblem } from '../src/config.js';

const base = { COMPANY_ISSUER: 'https://auth.example/env1/as', COMPANY_AGENT_CLIENT_ID: 'agent-1' };

test('defaults follow the design', () => {
  const c = configFrom(base);
  assert.deepEqual(c, {
    origin: 'http://127.0.0.1:5452', port: 5452, bind: '127.0.0.1', issuer: 'https://auth.example/env1/as',
    issuerJwksUri: 'https://auth.example/env1/as/jwks', audience: 'https://company.example/poppy', agentClientId: 'agent-1',
    agentJwksUri: 'http://127.0.0.1:5450/jwks.json', allowLoopback: true, orgName: 'Reference Company', clockSkewSeconds: 5,
  });
});

test('configFrom reads only the object it is given', () => {
  assert.throws(() => configFrom({}), /COMPANY_ISSUER is required/);
});

test('issuer and agent client id are required', () => {
  assert.throws(() => configFrom({ COMPANY_AGENT_CLIENT_ID: 'a' }), /COMPANY_ISSUER is required/);
  assert.throws(() => configFrom({ COMPANY_ISSUER: base.COMPANY_ISSUER }), /COMPANY_AGENT_CLIENT_ID is required/);
  assert.throws(() => configFrom({ ...base, COMPANY_AGENT_CLIENT_ID: '   ' }), /COMPANY_AGENT_CLIENT_ID is required/);
});

test('port must be a number in 5450-5499', () => {
  for (const bad of ['5449', '5500', '80', 'abc', '54.5', '-1', '5452x']) assert.throws(() => configFrom({ ...base, COMPANY_PORT: bad }), /COMPANY_PORT/, bad);
  assert.equal(configFrom({ ...base, COMPANY_PORT: '5450' }).port, 5450);
  assert.equal(configFrom({ ...base, COMPANY_PORT: '5499' }).port, 5499);
});

test('a non-loopback origin must be https and turns allowLoopback off by default', () => {
  assert.throws(() => configFrom({ ...base, COMPANY_ORIGIN: 'http://company.example' }), /must be https/);
  const c = configFrom({ ...base, COMPANY_ORIGIN: 'https://company.example', COMPANY_AGENT_JWKS_URI: 'https://agent.example/jwks.json' });
  assert.equal(c.allowLoopback, false);
  assert.equal(c.origin, 'https://company.example');
});

test('with allowLoopback off, an http loopback agent JWKS URI is refused', () => {
  assert.throws(() => configFrom({ ...base, COMPANY_ORIGIN: 'https://company.example' }), /COMPANY_AGENT_JWKS_URI .*COMPANY_ALLOW_LOOPBACK/);
});

test('COMPANY_ALLOW_LOOPBACK=0 forces http loopback off, 1 turns it on for an https origin', () => {
  assert.throws(() => configFrom({ ...base, COMPANY_ALLOW_LOOPBACK: '0' }), /COMPANY_ORIGIN .*COMPANY_ALLOW_LOOPBACK/);
  const c = configFrom({ ...base, COMPANY_ORIGIN: 'https://company.example', COMPANY_ALLOW_LOOPBACK: '1' });
  assert.equal(c.allowLoopback, true);
  assert.throws(() => configFrom({ ...base, COMPANY_ALLOW_LOOPBACK: 'yes' }), /must be 1 or 0/);
});

test('allowLoopback never makes a non-loopback http host acceptable', () => {
  assert.throws(() => configFrom({ ...base, COMPANY_ISSUER: 'http://auth.example/as' }), /COMPANY_ISSUER must be https/);
  assert.throws(() => configFrom({ ...base, COMPANY_AGENT_JWKS_URI: 'http://lab.example/jwks.json', COMPANY_ALLOW_LOOPBACK: '1' }), /COMPANY_AGENT_JWKS_URI must be https/);
  assert.throws(() => configFrom({ ...base, COMPANY_ISSUER_JWKS_URI: 'http://auth.example/jwks' }), /COMPANY_ISSUER_JWKS_URI must be https/);
});

test('an http loopback issuer works only while allowLoopback is on (tests)', () => {
  const c = configFrom({ ...base, COMPANY_ISSUER: 'http://127.0.0.1:6000' });
  assert.equal(c.issuerJwksUri, 'http://127.0.0.1:6000/jwks');
  assert.throws(() => configFrom({ ...base, COMPANY_ISSUER: 'http://127.0.0.1:6000', COMPANY_ALLOW_LOOPBACK: '0', COMPANY_ORIGIN: 'https://company.example' }), /COMPANY_ISSUER/);
});

test('origin must be a bare origin, the same text the lab is given', () => {
  for (const bad of ['http://127.0.0.1:5452/', 'http://127.0.0.1:5452/x', 'not a url', 'ftp://company.example', 'http://127.0.0.1:5452?x=1']) {
    assert.throws(() => configFrom({ ...base, COMPANY_ORIGIN: bad }), /COMPANY_ORIGIN/, bad);
  }
});

test('urlProblem refuses credentials, fragments and other schemes', () => {
  assert.match(urlProblem('https://u:p@auth.example/x', false), /credentials/);
  assert.match(urlProblem('https://auth.example/x#f', false), /fragment/);
  assert.match(urlProblem('ftp://auth.example/x', true), /https/);
  assert.equal(urlProblem('https://auth.example/x', false), null);
  assert.equal(urlProblem('http://localhost:5450/x', true), null);
  assert.equal(urlProblem('http://[::1]:5450/x', true), null);
  assert.match(urlProblem('http://localhost.example/x', true), /loopback/);
});

test('bind, audience, org name and the two JWKS URIs can be set', () => {
  const c = configFrom({ ...base, COMPANY_BIND: '0.0.0.0', COMPANY_AUDIENCE: 'https://x.example/api', COMPANY_ORG_NAME: 'Acme', COMPANY_ISSUER_JWKS_URI: 'https://auth.example/keys', COMPANY_AGENT_JWKS_URI: 'http://127.0.0.1:5461/jwks.json' });
  assert.deepEqual([c.bind, c.audience, c.orgName, c.issuerJwksUri, c.agentJwksUri], ['0.0.0.0', 'https://x.example/api', 'Acme', 'https://auth.example/keys', 'http://127.0.0.1:5461/jwks.json']);
});
