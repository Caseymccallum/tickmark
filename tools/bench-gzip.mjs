/**
 * Which gzip level, on the two shapes of page this product actually sends.
 *
 *   node tools/bench-gzip.mjs
 *
 * The choice is not a matter of taste: the stylesheet alone is 33 KB of highly repetitive CSS, and a board with five
 * hundred rows is an order of magnitude larger again. Higher levels buy progressively fewer bytes for progressively
 * more CPU, and past a point the trade is bad — a page nobody waits on, made slower to save bytes a practice on a
 * fast connection will never miss.
 */
import { gzipSync } from 'node:zlib';

import { STYLE } from '../src/style.js';

const ROW = (index) =>
  `<tr><td><span class="cell-t">Client ${index} Ltd</span></td><td>2025 return</td>` +
  `<td align="right"><strong>2</strong></td><td class="note">2026-01-31</td><td>waiting on the client</td></tr>`;

const page = (rows) =>
  Buffer.from(
    `<!doctype html><html><head><style>${STYLE}</style></head><body><main class="wrap"><table><tbody>${rows}</tbody></table></main></body></html>`,
    'utf8',
  );

const shapes = [
  ['a page with one row — what most pages are', page(ROW(0))],
  ['a board with 100 rows', page(Array.from({ length: 100 }, (_, i) => ROW(i)).join(''))],
  ['a board with 500 rows', page(Array.from({ length: 500 }, (_, i) => ROW(i)).join(''))],
];

for (const [what, bytes] of shapes) {
  console.log(`\n${what}: ${(bytes.length / 1024).toFixed(0)} KB`);
  for (const level of [1, 3, 4, 6, 9]) {
    gzipSync(bytes, { level });
    const at = process.hrtime.bigint();
    for (let i = 0; i < 10; i += 1) gzipSync(bytes, { level });
    const each = Number(process.hrtime.bigint() - at) / 1e6 / 10;
    const out = gzipSync(bytes, { level });
    console.log(
      `  level ${String(level).padStart(2)}: ${(out.length / 1024).toFixed(1).padStart(6)} KB ` +
        `(${String(Math.round((out.length / bytes.length) * 100)).padStart(2)}%) in ${each.toFixed(2)} ms`,
    );
  }
}
