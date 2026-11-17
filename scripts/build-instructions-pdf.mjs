// Builds docs/Poppy-Agent-Tester-Setup.pdf from the README section between the instructions markers.
// One source: edit the README, run `npm run instructions-pdf`, commit both. Needs Chrome (CHROME=/path to override).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const m = readme.match(/<!-- instructions:start -->\n([\s\S]*?)<!-- instructions:end -->/);
if (!m) { console.error('README has no instructions markers'); process.exit(1); }

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${/^https?:/.test(u) ? u : `https://github.com/curtismu7/poppy-agent-tester-LAB/blob/main/${u}`}">${t}</a>`);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

const lines = m[1].split('\n'); const out = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.startsWith('```')) { const code = []; i++; while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]); out.push(`<pre>${esc(code.join('\n'))}</pre>`); continue; }
  if (/^## /.test(l)) { out.push(`<h1>${inline(l.slice(3))}</h1>`); continue; }
  if (/^### /.test(l)) { out.push(`<h2>${inline(l.slice(4))}</h2>`); continue; }
  if (l.startsWith('|')) {
    const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]); i--;
    const [head, , ...body] = rows;
    out.push(`<table><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`);
    continue;
  }
  if (/^\d+\. /.test(l)) { const it = []; while (i < lines.length && /^\d+\. /.test(lines[i])) it.push(lines[i++].replace(/^\d+\. /, '')); i--; out.push(`<ol>${it.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`); continue; }
  if (/^- /.test(l)) { const it = []; while (i < lines.length && /^- /.test(lines[i])) it.push(lines[i++].slice(2)); i--; out.push(`<ul>${it.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); continue; }
  if (l.trim()) out.push(`<p>${inline(l)}</p>`);
}
const css = `body{font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#111;margin:0}h1{font-size:22px;border-bottom:3px solid #c8102e;padding-bottom:4px;margin:26px 0 10px}
h2{font-size:17px;margin:20px 0 6px}pre{background:#f2f4f7;padding:10px 12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:12.5px}
code{background:#f2f4f7;padding:1px 4px;border-radius:3px;font-size:12.5px}pre code{padding:0}table{border-collapse:collapse;width:100%;margin:8px 0;break-inside:avoid}
th,td{border:1px solid #ccd;padding:5px 8px;text-align:left;vertical-align:top}th{background:#eef1f5}a{color:#0b5cad}`;
const html = `<!doctype html><meta charset="utf-8"><title>Poppy Agent Tester LAB: set up and run</title><style>${css}</style><h1 style="font-size:28px;margin-top:0">Poppy Agent Tester LAB</h1><p>Set up and run. Source: README.md in the repository.</p>${out.join('\n')}`;

const tmp = path.join(os.tmpdir(), `poppy-instructions-${process.pid}.html`);
fs.writeFileSync(tmp, html);
const pdf = path.join(root, 'docs/Poppy-Agent-Tester-Setup.pdf');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, `file://${tmp}`], { stdio: 'ignore' });
fs.rmSync(tmp);
console.log('wrote', path.relative(root, pdf), fs.statSync(pdf).size, 'bytes');
