// Per-visitor state (rule 13): the workspace id picks one record, so one visitor's sign-in or Reset never touches another's.
// A record holds the delegated key, the chosen Company, the PKCE pair of a sign-in in progress, the token, and a bounded step log.
// Private keys never leave this module's callers: nothing here is serialised to the browser.
import crypto from 'node:crypto';
import { generateEs256Key } from './jose.js';

export const MAX_STEPS = 60;

export function createSessions({ max = 500, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // id -> record; insertion order = oldest first
  const sweep = () => {
    const t = now();
    for (const [id, v] of map) { if (t - v.at > ttlMs) map.delete(id); else break; }
    while (map.size > max) map.delete(map.keys().next().value);
  };
  const fresh = () => ({ at: now(), delegated: generateEs256Key(), sid: `sid-${crypto.randomBytes(16).toString('base64url')}`, config: null, discovery: null, pending: null, token: null, steps: [] });
  return {
    get(id) {
      sweep();
      let v = map.get(id);
      if (!v) v = fresh();
      v.at = now();
      map.delete(id); map.set(id, v); sweep();
      return v;
    },
    log(id, step) { const v = this.get(id); v.steps = [...v.steps, { ...step, at: new Date(now()).toISOString() }].slice(-MAX_STEPS); return v; },
    reset(id) { map.delete(id); },
    size() { return map.size; },
  };
}
