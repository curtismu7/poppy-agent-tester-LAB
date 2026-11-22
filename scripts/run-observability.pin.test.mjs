// Rule 27: the vendored shared/run-observability files match web/src/run-observability/run-observability.sha256 byte for byte.
// They come from curtismu7/AI-DEMO-Standalone shared/run-observability: change them there, re-pin, re-vendor; never edit them here.
// This lab reads logs in Real mode, so it vendors the readers file too and checkPin requires it to be pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every vendored run-observability file matches its pin, and the core and the readers are present', () => {
  assert.deepEqual(checkPin(root), []);
  assert.ok(fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')));
});

test('the core has no imports, no network and no file access, not even in a comment', () => {
  const core = fs.readFileSync(path.join(root, 'server/src/runObservability.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(core));
  assert.ok(!/ElasticsearchReader|DockerLogReader|readersFromEnv|\bfetch\s*\(|node:http|node:fs/.test(core));
});

// The pin check must bite: copy the lab's vendored files to a scratch folder and break each rule once.
function scratch(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-pin-'));
  try {
    for (const f of ['web/src/run-observability/RunObservability.jsx', 'web/src/run-observability/run-observability.css', 'web/src/run-observability/run-observability.test.jsx', 'web/src/run-observability/fixtures.js', 'web/src/run-observability/run-observability.sha256', 'server/src/runObservability.js', 'server/src/runObservabilityReaders.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    mutate(dir);
    return checkPin(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('an edited vendored byte fails the pin', () => {
  assert.notDeepEqual(scratch((d) => fs.appendFileSync(path.join(d, 'server/src/runObservability.js'), '\n// edited\n')), []);
});

test('an unpinned file in the vendored folder fails the pin', () => {
  assert.notDeepEqual(scratch((d) => fs.writeFileSync(path.join(d, 'web/src/run-observability/extra.js'), 'export {}\n')), []);
  assert.notDeepEqual(scratch((d) => fs.writeFileSync(path.join(d, 'server/src/runObservabilityExtra.js'), 'export {}\n')), []);
});

test('a missing core fails the pin', () => {
  assert.notDeepEqual(scratch((d) => fs.rmSync(path.join(d, 'server/src/runObservability.js'))), []);
});
