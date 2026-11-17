// The diagram data carries what the page needs to draw it readable: a short canvas label, a colour phase and the reply flag per step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagram, rawDiagram } from '../src/diagramData.js';

const PHASES = ['discover', 'signin', 'token', 'call'];

test('every step has a short label (at most 24 characters), a known phase and the phases run in order', () => {
  const d = buildDiagram('poppy-flow');
  assert.equal(d.steps.length, 10);
  let last = -1;
  for (const s of d.steps) {
    assert.ok(s.short && s.short.length <= 24, `short label: ${s.short}`);
    assert.ok(PHASES.includes(s.phase), `phase: ${s.phase}`);
    const at = PHASES.indexOf(s.phase);
    assert.ok(at >= last, 'phases never go back');
    last = at;
  }
  assert.deepEqual([...new Set(d.steps.map((s) => s.phase))], PHASES, 'all four phases are used');
});

test('a reply is marked as a reply, from the edge it walks', () => {
  const raw = rawDiagram('poppy-flow'); const d = buildDiagram('poppy-flow');
  d.steps.forEach((s, i) => assert.equal(s.reply, !!raw.edges[raw.steps[i].edges[0]].dashed));
  assert.equal(d.steps.filter((s) => s.reply).length, 5, 'five requests and five replies');
});

test('the full step titles stay for the narration', () => {
  const d = buildDiagram('poppy-flow');
  d.steps.forEach((s) => assert.ok(s.label.length >= s.short.length - 8 && s.label !== ''));
});

test('every step has a plain sentence, key fields and a spec citation for the pop-up', () => {
  const d = buildDiagram('poppy-flow');
  for (const s of d.steps) {
    assert.ok(s.plain.length >= 40 && s.plain.length <= 260, `plain: ${s.plain}`);
    assert.ok(s.fields.length >= 2 && s.fields.length <= 5 && s.fields.every((f) => f.length > 0 && f.length <= 100), `fields of ${s.label}`);
    assert.match(s.spec, /RFC \d+|Spec section/, `spec: ${s.spec}`);
  }
});
