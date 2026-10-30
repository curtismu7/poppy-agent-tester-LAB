import dns from 'node:dns';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNetguard, netguardSelfTest, permitHost, clearPermitted } from '../src/netguard.js';

test('the self-test proves every route out is refused', async () => {
  const r = await netguardSelfTest();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.blocked, 8);
});

test('the callback form of dns.lookupService is refused too, for a non-loopback address', async () => {
  const guard = installNetguard();
  try {
    const err = await new Promise((res) => dns.lookupService(['192', '0', '2', '1'].join('.'), 80, (e) => res(e)));
    assert.match(String(err && err.message), /network blocked/);
    assert.ok(guard.attempts.some((a) => a.startsWith('dns:')));
  } finally { guard.restore(); }
});

test('an unlisted host is refused and recorded; a permitted one gets past the guard', async () => {
  const guard = installNetguard();
  try {
    const before = guard.attempts.length;
    await assert.rejects(fetch('https://not-typed.invalid/'), /network blocked/);
    assert.equal(guard.attempts.length, before + 1);
    permitHost('typed.invalid');
    // Past the guard the request fails for a different reason (DNS for .invalid), never "network blocked".
    await assert.rejects(fetch('https://typed.invalid/', { signal: AbortSignal.timeout(3000) }), (e) => !/network blocked/.test(`${e.message} ${e.cause?.message ?? ''}`));
    clearPermitted();
    await assert.rejects(fetch('https://typed.invalid/'), /network blocked/);
  } finally { guard.restore(); clearPermitted(); }
});
