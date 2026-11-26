// checkPin.mjs — the ONE pin check for a lab that vendors the shared sequence-diagram view
// (from ciba-approval-sequence-LAB web/src, the family's sequence + movie-reel components).
// Vendor to scripts/sequence-checkPin.mjs (byte-for-byte), then call it from the lab's pin test:
//     import { checkPin } from '../scripts/sequence-checkPin.mjs';
//     assert.deepEqual(checkPin(labRoot), []);
// or run it: node scripts/sequence-checkPin.mjs <labRoot>   (exit 0 ok, 1 with the problems on stderr, 2 with the usage when no path is given).
// The pin file (web/src/sequence/sequence.sha256) lists each vendored file as "<sha256>  <lab-relative path>":
//   web/src/sequence/{SequenceFlowDiagram.jsx,SequenceFlowDiagram.css,DiagramReel.jsx,DiagramReel.css,SequenceActorHeader.jsx,SequenceActorHeader.css,diagram/UniqueReactFlow.jsx,parseSequence.js,diagramReel.js,specRefs.js,useReelSync.js}
// It FAILS when: the pin file is missing or has a line it cannot read, a duplicate, a non-canonical path (./, //, .., absolute) or a path that is not a
// vendored file; a required file is missing from the lab or from the pin; any file in web/src/sequence/ is not in the pin; a pinned file is a symlink,
// a directory or anything but a regular file (or resolves outside the lab); or a hash differs.
// Dependency-free (node:fs, node:path, node:url, node:crypto only).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PIN_FILE = 'scripts/sequence.sha256';
export const VENDORED = [
  'web/src/components/SequenceFlowDiagram.jsx', 'web/src/components/SequenceFlowDiagram.css',
  'web/src/components/DiagramReel.jsx', 'web/src/components/DiagramReel.css',
  'web/src/components/SequenceActorHeader.jsx', 'web/src/components/SequenceActorHeader.css',
  'web/src/components/diagram/UniqueReactFlow.jsx',
  'web/src/utils/parseSequence.js', 'web/src/utils/diagramReel.js', 'web/src/utils/specRefs.js',
  'web/src/hooks/useReelSync.js', 'web/src/hooks/useFitOnResize.js',
];

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonical = (rel) => typeof rel === 'string' && rel !== '' && !rel.startsWith('/') && !rel.includes('\\') && rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
const lst = (file) => { try { return fs.lstatSync(file); } catch { return null; } };

export function checkPin(labRoot, { pinFile = PIN_FILE } = {}) {
  const problems = [];
  let root;
  try { root = fs.realpathSync(path.resolve(String(labRoot))); } catch { return [`${String(labRoot)}: the lab folder does not exist`]; }
  const pst = lst(path.join(root, pinFile));
  if (!pst) return [`${pinFile}: the pin file is missing`];
  if (!pst.isFile()) return [`${pinFile}: the pin file is not a regular file`];
  let lines;
  try { lines = fs.readFileSync(path.join(root, pinFile), 'utf8').split('\n').filter((l) => l.trim()); } catch (e) { return [`${pinFile}: unreadable (${e.message})`]; }
  const pinned = new Map();
  for (const [n, line] of lines.entries()) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line.trim());
    if (!m) { problems.push(`${pinFile}:${n + 1}: not "<sha256>  <path>"`); continue; }
    const [, hash, rel] = m;
    if (!canonical(rel)) { problems.push(`${pinFile}:${n + 1}: the path is not lab-relative canonical: ${rel}`); continue; }
    if (pinned.has(rel)) problems.push(`${pinFile}: ${rel} is pinned twice`);
    pinned.set(rel, hash);
  }
  if (problems.length) return problems;
  for (const rel of VENDORED) {
    if (!pinned.has(rel)) { problems.push(`${pinFile}: the required file ${rel} is not pinned`); continue; }
    const st = lst(path.join(root, rel));
    if (!st) { problems.push(`${rel}: pinned but missing from the lab`); continue; }
    if (!st.isFile()) { problems.push(`${rel}: not a regular file`); continue; }
    const real = fs.realpathSync(path.join(root, rel));
    if (!real.startsWith(root + path.sep)) { problems.push(`${rel}: resolves outside the lab`); continue; }
    const actual = sha(path.join(root, rel));
    if (actual !== pinned.get(rel)) problems.push(`${rel}: the file does not match its pin (an edited copy; change the canonical lab first, then re-vendor and re-pin)`);
  }
  return problems;
}

const here = (import.meta.url === `file://${process.argv[1]}`) || (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));
if (here) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node scripts/sequence-checkPin.mjs <labRoot>   (or --write <sourceLabDir> to re-pin)'); process.exit(2); }
  if (process.argv[2] === '--write') {
    const src = process.argv[3];
    if (!src) { console.error('usage: node scripts/sequence-checkPin.mjs --write <sourceLabDir>'); process.exit(2); }
    fs.writeFileSync(path.join(path.resolve(target), PIN_FILE), pinText(src));
    console.log(`wrote ${PIN_FILE}`);
    process.exit(0);
  }
  const problems = checkPin(target);
  if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }
  console.log('sequence pin ok');
  process.exit(0);
}
