import { LANTERN_DIR } from './paths.mjs'
import fs from 'node:fs';
import path from 'node:path';
const dir = `${LANTERN_DIR}/lib`;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
const exports = {}; // file -> Set(names)
const imports = []; // {from, file, names}
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const ex = new Set();
  for (const m of src.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)|^export class (\w+)/gm)) {
    ex.add(m[1] || m[2] || m[3]);
  }
  // export { a, b } from './x.js'
  for (const m of src.matchAll(/^export \{([^}]+)\} from '([^']+)'/gm)) {
    for (const n of m[1].split(',')) { const t = n.trim().split(' as ')[0].trim(); if (t) ex.add(t); }
  }
  // import ... from '...'
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/gm)) {
    if (!m[2].startsWith('.')) continue;
    const target = path.join(dir, m[2].startsWith('./') ? m[2].slice(2) : m[2]);
    imports.push({ file: f, names: m[1].split(',').map(s => s.trim().split(' as ')[0].trim()).filter(Boolean), target });
  }
  exports[f] = ex;
}
let bad = 0;
for (const im of imports) {
  const tf = path.basename(im.target) + (im.target.endsWith('.js') ? '' : '.js');
  const targetFile = files.find(f => f === tf) || files.find(f => f === tf.replace(/\.js$/, '') + '.js');
  if (!targetFile) { console.log('MISSING FILE: ' + im.file + ' imports from ' + im.target); bad++; continue; }
  const avail = exports[targetFile];
  if (!avail) continue;
  for (const n of im.names) {
    if (!avail.has(n)) { console.log('MISSING EXPORT: ' + im.file + ' imports {' + n + '} from ' + targetFile + ' — not found'); bad++; }
  }
}
console.log(bad === 0 ? 'IMPORT-CHECK: ALL OK' : 'IMPORT-CHECK: ' + bad + ' issues');
