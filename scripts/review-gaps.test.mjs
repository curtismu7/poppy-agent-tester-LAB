// Pins two properties the second review found untested: the control-contrast tokens meet their stated ratios, and the diagram
// controls never hard-code a colour. Reads the CSS as text; no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// The surfaces a control sits on, per theme, as the tokens define them.
const THEMES = {
  light: { page: '#f6f7f9', card: '#ffffff', inset: '#eff0f1', border: '#6b7a8c', focus: '#12538d', placeholder: '#5a6675', onAccent: '#ffffff', accent: '#b5231a' },
  dark: { page: '#0b1220', card: '#131c2e', inset: '#1b2540', border: '#8b9ab0', focus: '#93c5fd', placeholder: '#a3b0c2', onAccent: '#0b1220', accent: '#ef6b61' },
};

test('the control-border token is at least 3:1 on every surface, both themes (WCAG 1.4.11)', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    for (const s of ['page', 'card', 'inset']) assert.ok(ratio(t.border, t[s]) >= 3, `${name} border on ${s}: ${ratio(t.border, t[s]).toFixed(2)}`);
  }
});

test('the focus ring is at least 3:1 and the placeholder at least 4.5:1 on the card, both themes', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(ratio(t.focus, t.card) >= 3, `${name} focus`);
    assert.ok(ratio(t.placeholder, t.card) >= 4.5, `${name} placeholder`);
  }
});

test('text on a filled accent is at least 4.5:1, both themes', () => {
  for (const [name, t] of Object.entries(THEMES)) assert.ok(ratio(t.onAccent, t.accent) >= 4.5, `${name} on accent`);
});

test('the tokens.css values are the ones this test checks (the light and dark blocks cannot drift apart unnoticed)', () => {
  const css = read('web/src/tokens.css');
  assert.match(css, new RegExp(`--control-border:\\s*${THEMES.light.border}`, 'i'));
  assert.match(css, new RegExp(`--control-border:\\s*${THEMES.dark.border}`, 'i'));
  assert.match(css, new RegExp(`--th-placeholder:\\s*${THEMES.dark.placeholder}`, 'i'));
});

test('the diagram control styles use tokens only: no hard-coded colour', () => {
  for (const f of ['web/src/components/diagram/DiagramControls.css', 'web/src/components/diagram/StepTimeSelector.css', 'web/src/components/DiagramStepBar.css']) {
    const hex = read(f).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hex, [], f);
  }
});
