import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createHealth } from '../src/health.js';

// Regression: the header "Shelf" button reads GET /api/shelf. It used to sit after the /api 404 handler and
// inside the web-build check, so it never answered. It must answer with no web build present.
test('GET /api/shelf returns SHELF_URL (trailing slash trimmed) without a web build; POST is not 200', async () => {
  const prev = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  const app = createApp({ agent: null, baseUrl: '', health: createHealth({ runChecks: async () => [], intervalMs: 3_600_000 }) });
  const server = await new Promise((res) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/shelf`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
    const p = await fetch(`${base}/api/shelf`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.notEqual(p.status, 200);
  } finally {
    if (prev === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = prev;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
