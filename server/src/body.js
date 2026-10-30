// Read a response body without ever holding more than `max` bytes: stop reading and cancel the stream the moment it passes the cap.
// (res.text() and res.json() read everything first, so a hostile server could fill memory until the timeout.)
export class BodyTooLarge extends Error {
  constructor(max) { super(`response is larger than ${max} bytes`); this.code = 'too_large'; }
}

export async function readCapped(res, max) {
  if (!res.body) return '';
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) { try { await res.body.cancel(); } catch { /* already closed */ } throw new BodyTooLarge(max); }
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* already closed */ } throw new BodyTooLarge(max); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Like readCapped but cut at `max` instead of failing: for text we only display. */
export async function readClipped(res, max) {
  try { return await readCapped(res, max); } catch (e) {
    if (e instanceof BodyTooLarge) return `(response is larger than ${max} bytes and was not read)`;
    throw e;
  }
}
