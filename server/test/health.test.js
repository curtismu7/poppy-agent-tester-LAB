import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHealth } from '../src/health.js';

const body = (router) => new Promise((resolve, reject) => {
  const app = express();
  app.use('/api/health', router);
  const server = app.listen(0, '127.0.0.1', () => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/health' }, (r) => {
      let text = '';
      r.on('data', (c) => { text += c; });
      r.on('end', () => { server.close(); resolve(JSON.parse(text)); });
    }).on('error', reject);
  });
});

test('health reports runtime live for a local run and offline for the hosted build', async () => {
  const live = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  const offline = createHealth({ runChecks: async () => [], intervalMs: 3_600_000, runtime: 'offline' });
  await Promise.all([live.ready, offline.ready]);
  try {
    assert.equal((await body(live.router)).runtime, 'live');
    assert.equal((await body(offline.router)).runtime, 'offline');
  } finally { live.stop(); offline.stop(); }
});
