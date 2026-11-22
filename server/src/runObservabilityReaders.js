// runObservabilityReaders.js — the log READERS for runObservability.js (Rule 27). Vendor to server/src/runObservabilityReaders.js, beside the
// core. A lab that reads no logs does not vendor this file (it then needs no network or socket exemption in its safety tests).
// Dependency-free ESM, Node >= 22. Imports only the core.
//
// A reader has { name, canRead(product), readLines({ product, from, to, match }) -> { lines, truncated, notes? } } and throws ReaderError when it cannot read
// (never an empty answer for a failure). A line is { at (epoch ms), atExact (the source's own timestamp text, ISO only), product, message, host?, level?, requestId? }.
// `match(line)` (optional) keeps only the lines the caller cares about. DOCKER AND FILE: applied BEFORE the cap, so the cap counts only relevant lines.
// ELASTICSEARCH: the query is the window plus the product and NOTHING else (no id filter, no text filter), and `match` runs AFTER Elasticsearch has
// returned its newest 500 documents, so noise in the window can push a relevant line out; that is reported as `truncated`.
// When more lines remain than the cap, the NEWEST are kept and `truncated` is true: the caller then says absence is not proof.
// Reader selection (in the core): the first reader that returns lines wins; a reader that returns none is not the end, the next one is consulted.
//   DockerLogReader       opt-in (RUN_OBS_DOCKER=1): GET /containers/{name}/logs on the Docker engine socket, and a read-only REGULAR log file. Never POST, never exec.
//   ElasticsearchReader   the default: ONE read-only POST /<index>/_search to a LOOPBACK URL with a read-only key. Never follows a redirect.
import http from 'node:http';
import fs from 'node:fs/promises';
import { ReaderError, LIMITS, ISO_RE, NAME_OK, safeName } from './runObservability.js';

const ANSI = /\u001b\[[0-9;]*m/g;
const nullMap = (o) => { const out = Object.create(null); for (const [k, v] of Object.entries(o || {})) if (safeName(k)) out[k] = v; return out; };
const has = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/s;

// Docker's log stream is multiplexed (8-byte header per frame) unless the container has a TTY.
function demux(buf) {
  if (!(buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0)) return buf.toString('utf8');
  const parts = [];
  for (let i = 0; i + 8 <= buf.length;) {
    const size = buf.readUInt32BE(i + 4);
    if (i + 8 + size > buf.length) { parts.push(buf.subarray(i + 8)); break; }
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

// Lines that start with a space or tab continue the entry above (an indented detail block, a PingFederate [CONTINUED] dump), EXCEPT under an entry whose
// first line is JSON: an indented line after a JSON object is never part of it (it would break the parse and hide the real line, or forge one), and an
// indented line with nothing above it is dropped.
const jsonFirstLine = (m) => {
  const f = m.split('\n', 1)[0].slice(0, LIMITS.maxLine).replace(ANSI, '').trimStart();
  if (!f.startsWith('{')) return false;
  try { JSON.parse(f); return true; } catch { return false; }
};
function joinContinuations(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.continuation) { out.push({ ...r }); continue; }
    const prev = out.at(-1);
    if (!prev || jsonFirstLine(prev.message)) continue;
    prev.message += `\n${r.message}`;
  }
  return out;
}

function finish(rows, { product, from, to, match, host }) {
  const lines = [];
  for (const r of joinContinuations(rows)) {
    if (!Number.isFinite(r.at) || r.at < from || r.at > to) continue;
    const line = { at: r.at, atExact: r.atExact, product, message: r.message, ...(r.level ? { level: r.level } : {}), ...(r.requestId ? { requestId: r.requestId } : {}), ...((r.host || host) ? { host: r.host || host } : {}) };
    if (match && !match(line)) continue;
    lines.push(line);
  }
  const truncated = lines.length > LIMITS.maxLines;
  return { lines: truncated ? lines.slice(-LIMITS.maxLines) : lines, truncated };
}

export class DockerLogReader {
  // containers: { product: containerName }; files: { product: absolute path of a log file mounted read-only }
  constructor({ socketPath = '/var/run/docker.sock', containers = {}, files = {}, timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes } = {}) {
    this.name = 'docker';
    this.socketPath = socketPath; this.containers = nullMap(containers); this.files = nullMap(files); this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }

  canRead(product) { return has(this.containers, product) || has(this.files, product); }

  // The ONLY Docker request this class can make: GET /containers/{name}/logs. No POST, no exec, no other path.
  #get(name, from, to) {
    if (!NAME_OK.test(name)) throw new ReaderError('docker_bad_name', 'The configured container name is not a plain name.');
    const path = `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&since=${Math.floor(from / 1000)}&until=${Math.ceil(to / 1000) + 1}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, method: 'GET', headers: { host: 'docker' }, timeout: this.timeoutMs }, (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > this.maxBytes) { req.destroy(new ReaderError('docker_too_large', 'Docker returned more log than this panel will read; narrow the window.')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode === 404) return reject(new ReaderError('docker_no_container', `Docker has no container named ${name}.`));
          if (res.statusCode !== 200) return reject(new ReaderError('docker_error', `Docker answered HTTP ${res.statusCode}.`));
          resolve(body);
        });
        res.on('error', (e) => reject(e instanceof ReaderError ? e : new ReaderError('docker_unreachable', `Docker socket read failed (${String(e.code || e.message).slice(0, 40)}).`)));
      });
      req.on('timeout', () => req.destroy(new ReaderError('docker_timeout', 'Docker did not answer in time.')));
      req.on('error', (e) => reject(e instanceof ReaderError ? e : new ReaderError('docker_unreachable', `Docker socket not reachable (${String(e.code || e.message).slice(0, 40)}).`)));
      req.end();
    });
  }

  async readLines({ product, from, to, match }) {
    const file = has(this.files, product) ? this.files[product] : null;
    let notes;
    if (file) {
      try { return await this.#readFile(file, { product, from, to, match }); } catch (e) {
        if (!has(this.containers, product)) throw e;
        notes = [`the log file was not used (${e instanceof ReaderError ? e.message : 'unexpected error'}); read from the container instead`];
      }
    }
    const name = has(this.containers, product) ? this.containers[product] : null;
    if (!name) throw new ReaderError('docker_not_configured', `No container is configured for ${product}.`);
    const text = demux(await this.#get(name, from, to));
    const rows = [];
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      const m = DOCKER_TS.exec(raw);
      if (!m) { if (/^[ \t]/.test(raw)) rows.push({ continuation: true, message: raw.trim() }); continue; }
      const body = m[2].replace(/\r$/, '');
      const cont = /^[ \t]/.test(body) && rows.length > 0;
      rows.push({ at: Date.parse(m[1]), atExact: m[1], message: cont ? body.trim() : body, continuation: cont });
    }
    return { ...finish(rows, { product, from, to, match, host: name }), ...(notes ? { notes } : {}) };
  }

  // A log file mounted read-only (the Privilege gateway writes cyonproxy.log to a file, not stdout). Lines start with time=<RFC 3339>.
  // Only a REGULAR file is read (a FIFO, a device or a directory is a named error, and the open cannot block). The exact time format is UNVERIFIED:
  // a line whose time is not an ISO timestamp is skipped, never given a guessed time. Only the LAST maxBytes of the file are read; when the window
  // starts before what was read, the answer is marked truncated. CRLF lines are read.
  async #readFile(path, ctx) {
    let handle;
    const timer = {};
    try {
      const st = await fs.stat(path);
      if (!st.isFile()) throw new ReaderError('file_not_regular', `The log path for ${ctx.product} is not a regular file (${st.isDirectory() ? 'a directory' : st.isFIFO() ? 'a FIFO' : st.isCharacterDevice() || st.isBlockDevice() ? 'a device' : 'something else'}).`);
      if (st.size === 0) return { lines: [], truncated: false, notes: ['the log file is empty'] };
      const deadline = new Promise((_, reject) => { timer.id = setTimeout(() => reject(new ReaderError('file_timeout', `The log file for ${ctx.product} did not open in time.`)), 3000); });
      handle = await Promise.race([fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK), deadline]);
      const { size } = await handle.stat();
      const length = Math.min(size, this.maxBytes);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, size - length);
      const rows = [];
      for (const raw of buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
        const m = /^time="?([^"\s]+)"?\s+(.*)$/.exec(raw);
        if (m && ISO_RE.test(m[1])) rows.push({ at: Date.parse(m[1]), atExact: m[1], message: m[2] });
      }
      const out = finish(rows, ctx);
      if (size > bytesRead && (rows.length === 0 || ctx.from < rows[0].at)) {
        return { ...out, truncated: true, notes: [`only the last ${bytesRead} bytes of the log file were read and the run window starts earlier`] };
      }
      return out;
    } catch (e) {
      if (e instanceof ReaderError) throw e;
      throw new ReaderError('file_unreadable', `The log file for ${ctx.product} is not readable (${String(e.code || e.message).slice(0, 40)}).`);
    } finally { clearTimeout(timer.id); await handle?.close(); }
  }
}

const SECRET_FIELD = /(secret|token|password|authorization|api[-_]?key|private[-_]?key|credential)/i;
function scrubDoc(value, key = '', depth = 0) {
  if (depth > LIMITS.maxDepth) return '<too deep>';
  if (key && SECRET_FIELD.test(key) && typeof value !== 'number' && typeof value !== 'boolean') return '<redacted>';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDoc(v, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [k, scrubDoc(v, k, depth + 1)]));
  return value;
}

const SIEM_INDEX = 'ping-siem-events-v2';
const LOGS_INDEXES = 'ping-logs-*,demo-logs-*';
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

export class ElasticsearchReader {
  // url: a loopback origin (an Elasticsearch port-forward); apiKey: a READ-ONLY key. Neither is ever returned or logged.
  constructor({ url, apiKey, timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes } = {}) {
    this.name = 'elasticsearch';
    this.url = url; this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }

  canRead() { return true; }

  async readLines({ product, from, to, match }) {
    if (!this.url || !this.apiKey) throw new ReaderError('es_not_configured', 'Elasticsearch is not configured (RUN_OBS_ES_URL and RUN_OBS_ES_READ_APIKEY).');
    let u;
    try { u = new URL(this.url); } catch { throw new ReaderError('es_bad_url', 'RUN_OBS_ES_URL is not a URL.'); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !LOOPBACK.test(u.hostname)) {
      throw new ReaderError('es_not_loopback', 'RUN_OBS_ES_URL must be a plain loopback http(s) URL (a port-forward on 127.0.0.1).');
    }
    const siem = product === 'privilege-siem';
    const index = siem ? SIEM_INDEX : LOGS_INDEXES;
    const filter = [{ range: { '@timestamp': { gte: new Date(from).toISOString(), lte: new Date(to).toISOString() } } }];
    if (!siem) filter.push({ bool: { should: [{ term: { ping_product: product } }, { term: { demo_service: product } }], minimum_should_match: 1 } });
    // Newest first: when the window holds more than the cap, it is the START of the run that is cut, and the caller is told so.
    const body = JSON.stringify({ size: LIMITS.maxHits, track_total_hits: false, sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }], query: { bool: { filter } } });
    let res;
    try {
      res = await fetch(`${u.origin}/${index}/_search`, {
        method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `ApiKey ${this.apiKey}` },
      });
    } catch (e) {
      throw new ReaderError('es_unreachable', `Could not reach Elasticsearch at ${u.host}: ${String(e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || (/redirect/i.test(`${e.message} ${e.cause?.message}`) ? 'refused a redirect' : 'network error')).slice(0, 60)}.`);
    }
    if (Number(res.headers.get('content-length') || 0) > this.maxBytes) throw new ReaderError('es_too_large', 'Elasticsearch answered with more data than this panel will read; narrow the window.');
    const chunks = []; let bytes = 0;
    try {
      for await (const c of res.body ?? []) {
        bytes += c.length;
        if (bytes > this.maxBytes) throw new ReaderError('es_too_large', 'Elasticsearch answered with more data than this panel will read; narrow the window.');
        chunks.push(c);
      }
    } catch (e) {
      if (e instanceof ReaderError) throw e;
      throw new ReaderError('es_timeout', `Elasticsearch did not finish answering in time (${String(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out' : e.cause?.code || 'connection error').slice(0, 60)}).`);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (res.status === 401 || res.status === 403) throw new ReaderError('es_unauthorized', `Elasticsearch refused the read credential (HTTP ${res.status}).`);
    if (!res.ok) throw new ReaderError('es_error', `Elasticsearch answered HTTP ${res.status}.`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ReaderError('es_bad_response', 'Elasticsearch did not answer with JSON.'); }
    if (!Array.isArray(parsed?.hits?.hits)) throw new ReaderError('es_bad_response', 'Elasticsearch answered with something other than search hits.');
    const rows = [];
    for (const h of parsed.hits.hits) {
      const src = h && typeof h._source === 'object' && h._source ? h._source : null;
      const stamp = src?.['@timestamp'];
      // Only an ISO timestamp is trusted as "exact"; a document with any other @timestamp is skipped, never given a guessed time.
      if (!src || typeof stamp !== 'string' || !ISO_RE.test(stamp)) continue;
      const message = typeof src.message === 'string' ? src.message.slice(0, 20000) : JSON.stringify(scrubDoc(src));
      rows.push({ at: Date.parse(stamp), atExact: stamp, message, level: typeof src.level === 'string' ? src.level : undefined, requestId: typeof src.request_id === 'string' ? src.request_id : undefined, host: typeof src.host === 'string' ? src.host : undefined });
    }
    rows.reverse(); // oldest first, like the other readers
    const out = finish(rows, { product, from, to, match });
    out.truncated ||= parsed.hits.hits.length >= LIMITS.maxHits;
    return out;
  }
}

// product=container,product=container  ->  { product: container }
const pairs = (text) => nullMap(Object.fromEntries(String(text || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2 && safeName(p[0].trim()) && p[1].trim()).map(([k, v]) => [k.trim(), v.trim()])));

// The readers, in selection order, from the environment (owner decision 2026-11-22): Elasticsearch is the DEFAULT reader (the log collector
// is the only thing that holds the Docker socket and ships to it; a lab reads Elasticsearch with a read key).
// The Docker reader is opt-in: it needs RUN_OBS_DOCKER=1 AND RUN_OBS_CONTAINERS / RUN_OBS_LOG_FILES, because it means mounting the Docker
// socket into the lab (even read-only it exposes the whole Docker API), which breaks the loopback-only, non-root, read-only-fs rules.
// Use it for an ad-hoc run or a video capture only.
export function readersFromEnv(env = process.env) {
  const out = [];
  if (env.RUN_OBS_ES_URL && env.RUN_OBS_ES_READ_APIKEY) out.push(new ElasticsearchReader({ url: env.RUN_OBS_ES_URL, apiKey: env.RUN_OBS_ES_READ_APIKEY }));
  const containers = pairs(env.RUN_OBS_CONTAINERS); const files = pairs(env.RUN_OBS_LOG_FILES);
  if (env.RUN_OBS_DOCKER === '1' && (Object.keys(containers).length || Object.keys(files).length)) {
    out.push(new DockerLogReader({ socketPath: env.RUN_OBS_DOCKER_SOCKET || '/var/run/docker.sock', containers, files }));
  }
  return out;
}
