// Story wiring: the lab's own glue between the shared Story engine (web/src/story/, vendored) and this page. It turns the script (storyScript.js) into engine
// steps and gives the engine a `host` that reads and drives the page: the tabs, the chat's chips, the run events. It never edits the page's own markup; it
// clicks the page's own buttons with script-made events (isTrusted is false, so Play for me is not mistaken for the viewer's own input).
//
// The chat announces runs with pat:run-start and pat:run-end ({ ok }): ok is false only when the request itself failed. A refused sign-in or a call the
// Company rejects completes normally (the refusal is the answer), so it is a run that ended ok.

import { STEPS } from './storyScript.js';

const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHost({ win = window, doc = document, mode = () => 'mock', settleMs = 400 } = {}) {
  const runs = { starts: 0, ends: 0, lastOk: true };
  const waiters = new Set();
  const timers = new Set();
  const watchers = new Set();
  const onStart = () => { runs.starts += 1; watchers.forEach((f) => f()); };
  const onEnd = (e) => {
    runs.ends += 1; runs.lastOk = e.detail ? e.detail.ok !== false : true;
    for (const w of [...waiters]) w(runs.lastOk);
    watchers.forEach((f) => f());
  };
  // A Reset clears the page's state: a step waiting for a run is told so (and the run's own end, which follows, finds nobody waiting).
  const onReset = () => { for (const w of [...waiters]) w(false, 'The page was reset. Press Next to carry on, or Exit.'); };
  win.addEventListener('pat:run-start', onStart);
  win.addEventListener('pat:run-end', onEnd);
  win.addEventListener('pat:reset', onReset);

  const q = (sel) => doc.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => { if (!el || el.disabled) throw new Error('the button is not available'); el.click(); };

  return {
    mode,
    query: q,
    mark: () => ({ starts: runs.starts, ends: runs.ends }),
    runStarted: (m) => runs.starts > m.starts,
    runInFlight: () => runs.starts > runs.ends,
    onRun: (cb) => { watchers.add(cb); return () => watchers.delete(cb); },
    waitForRun(m, timeoutMs) {
      return new Promise((resolve) => {
        const finish = (r) => { clearTimeout(t); timers.delete(t); waiters.delete(check); resolve(r); };
        const done = (ok, reason) => finish(ok ? { ok: true } : { ok: false, reason: reason || 'The run failed. Press Next to carry on, or Exit.' });
        const check = (ok, reason) => { if (reason || runs.ends > m.ends) done(ok, reason); };
        const t = setTimeout(() => finish({ ok: false, reason: 'The run did not finish in time. Press Next to carry on, or Exit.' }), timeoutMs);
        timers.add(t);
        if (runs.ends > m.ends) { done(runs.lastOk); return; }
        waiters.add(check);
      });
    },
    prefill(step) {
      if (!step.prompt || !step.prompt.text) return;   // this lab prompts by pressing an existing chip, not by typing
    },
    send(step) {
      if (step.prompt && step.prompt.press) { click(q(step.prompt.press)); return; }
      throw new Error('the step has no button to press');
    },
    switchTab(tab) {
      const el = q(`#tab-${tab}`);
      if (el && el.getAttribute('aria-current') !== 'page') el.click();
    },
    assetUrl: () => null,   // no screenshot ships; a slide is text-only
    dispose() { win.removeEventListener('pat:run-start', onStart); win.removeEventListener('pat:run-end', onEnd); win.removeEventListener('pat:reset', onReset); timers.forEach(clearTimeout); timers.clear(); waiters.clear(); watchers.clear(); },
    _sleep: sleep, _settleMs: settleMs,
  };
}

// ---- finding what a bubble points at. A target that is not on the page skips the step, so a bubble never claims something the page does not show.
// The chat renders one step row per kind it has run (data-testid=atlas-step-<kind>); the sequence/reel sit in [data-testid=sequence-view].
const rowByKind = (kind) => () => document.querySelector(`[data-testid=atlas-step-${kind}]`);

function targetFor(doc, t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return () => t(doc);
  return null;
}

// ---- conditions, read from the page's own state (the chat's step rows and phase chips)
const hasStep = (kind) => (doc) => !!doc.querySelector(`[data-testid=atlas-step-${kind}]`);

const CONDITIONS = {
  // Hosted builds reach no Company: the mock note shows first and the live prompts are skipped.
  hosted: (doc) => () => !!doc.querySelector('[data-testid=atlas-hint]'),
  notDiscovered: (doc) => () => !hasStep('discover')(doc),
  discovered: (doc) => () => hasStep('discover')(doc) && !hasStep('authorize')(doc) && !hasStep('token')(doc),
  // The sign-in bubble shows only once the run actually got past the person's sign-in (the token row exists) — after the redirect the page reloaded,
  // the story restarted, and this condition is what makes the walk continue from there instead of claiming a sign-in that never landed.
  signedInOrBeyond: (doc) => () => hasStep('token')(doc),
};

export const NOT_YET = [];

/** The script as engine steps. */
export function buildSteps({ host, doc = document, win = window, script = STEPS, notYet = NOT_YET }) {
  let tab;
  return script.filter((s) => !notYet.includes(s.key)).map((s) => {
    if (s.tab) tab = s.tab;
    const step = { key: s.key, type: s.type, trigger: s.trigger, modes: s.modes, sampleKey: s.sampleKey, prefer: s.prefer, tab };
    if (s.prompt) step.prompt = s.prompt;
    if (s.when) step.when = CONDITIONS[s.when](doc);
    if (s.type === 'bubble') {
      step.target = s.targetKind ? rowByKind(s.targetKind) : targetFor(doc, s.target);
      // A run-done bubble can win the race with React's own re-render: the run-end event fires before the chat has drawn the step row the bubble
      // points at, and advance() would then skip the step (its target is not on the page yet). Wait — briefly — for the row before it is judged.
      if (s.trigger === 'run-done') {
        step.before = async () => {
          for (let waited = 0; waited < 2000 && !step.target(); waited += 100) await sleep(100);
        };
      }
    }
    return step;
  });
}
