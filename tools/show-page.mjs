/**
 * Print the body of a captured page, with the stylesheet dropped — enough to read the markup
 * without scrolling past 300 lines of CSS. Used by hand while working on the look.
 *
 *   node tools/show-page.mjs tmp-snapshot/board.html
 *   node tools/show-page.mjs tmp-snapshot/board.html --scripts   # keep the json/script tags
 */
import { readFileSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/show-page.mjs <captured .html> [--scripts]');
  process.exit(1);
}

let page = readFileSync(file, 'utf8').replace(/<style[^>]*>[\s\S]*?<\/style>/, '<style>…</style>');
if (!flags.includes('--scripts')) {
  page = page.replace(/<script[\s\S]*?<\/script>/g, '<script>…</script>');
}

console.log(page.replace(/\n\s*\n/g, '\n'));
