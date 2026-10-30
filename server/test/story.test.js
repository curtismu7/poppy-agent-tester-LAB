import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSample } from '../src/sample.js';
import os from 'node:os';
import path from 'node:path';
import { TALK_TRACK, buildStory, renderTalkTrackMarkdown } from '../src/story.js';
import { VERTICALS, DEFAULT_CAST, loadCast, unfilled, verticalFrom } from '../src/cast.js';
import { modeFrom, hostedFrom } from '../src/config.js';
import { scanHosts } from '../src/safety.js';

test('every {{token}} in the story is defined by every vertical pack, and there are three packs', () => {
  assert.equal(Object.keys(VERTICALS).length, 3);
  const text = JSON.stringify(TALK_TRACK);
  for (const [name, cast] of Object.entries(VERTICALS)) assert.deepEqual(unfilled(text, cast), [], name);
  assert.ok(unfilled('{{castNope}}', DEFAULT_CAST).includes('castNope'), 'an undefined token is detected');
});

test('a filled story has no token left, and each vertical changes the words', () => {
  const a = JSON.stringify(buildStory(VERTICALS.banking).talkTrack);
  const b = JSON.stringify(buildStory(VERTICALS.travel).talkTrack);
  assert.ok(!/\{\{/.test(a) && !/\{\{/.test(b));
  assert.notEqual(a, b);
  assert.match(renderTalkTrackMarkdown(DEFAULT_CAST), /Fabrikam Bank/);
});

test('the story names no real host, and an unknown vertical falls back to the default', () => {
  assert.deepEqual(scanHosts(JSON.stringify(TALK_TRACK)), []);
  assert.equal(verticalFrom('nope'), 'banking');
});

test('customer.config.json can rename the brand, and hostile values are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-'));
  const f = path.join(dir, 'customer.config.json');
  fs.writeFileSync(f, JSON.stringify({ cast: { brand: 'Acme Corp', scope: 'a b', host: 'https://evil.example', agentName: 'x@evil.example' } }));
  const c = loadCast(f);
  assert.equal(c.castBrand, 'Acme Corp');
  assert.equal(c.castScope, DEFAULT_CAST.castScope);
  assert.equal(c.castHost, DEFAULT_CAST.castHost);
  assert.equal(c.castAgentName, DEFAULT_CAST.castAgentName);
  assert.equal(loadCast(path.join(dir, 'missing.json')).castBrand, DEFAULT_CAST.castBrand);
});

test('MODE=mock and PAT_HOSTED=1 are the hosted build; the default is a live local run', () => {
  assert.equal(modeFrom({}), 'live');
  assert.equal(hostedFrom({}), false);
  assert.equal(hostedFrom({ MODE: 'mock' }), true);
  assert.equal(hostedFrom({ PAT_HOSTED: '1' }), true);
  assert.equal(modeFrom({ MODE: 'anything-else' }), 'live');
});

test('the example run uses only reserved hosts, no private key, and says it is an example', () => {
  const sample = buildSample();
  assert.equal(sample.example, true);
  assert.deepEqual(scanHosts(JSON.stringify(sample)).filter((h) => !/\.example$/.test(h)), []);
  assert.ok(!/"d":/.test(JSON.stringify(sample)), 'no private JWK member');
});
