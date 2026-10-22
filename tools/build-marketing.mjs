import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DESIGN_TOKENS } from '../src/style.js';
import { publicOrigin } from '../src/public-urls.js';

const source = new URL('../site/index.html', import.meta.url);
const original = readFileSync(source, 'utf8');
const tokenBlock = `/* TICKMARK TOKENS START */\n${DESIGN_TOKENS.trim()}\n/* TICKMARK TOKENS END */`;
let html = original.replace(/\/\* TICKMARK TOKENS START \*\/[\s\S]*?\/\* TICKMARK TOKENS END \*\//, tokenBlock);
if (process.argv.includes('--sync')) {
  writeFileSync(source, html);
  console.log('Synced canonical design tokens into the standalone marketing source.');
} else {
  for (const key of ['TICKMARK_PUBLIC_URL', 'TICKMARK_MARKETING_URL']) {
    if (process.env[key] && !publicOrigin(process.env[key])) throw new Error(`${key} must be an HTTPS origin without a path, credentials, query or fragment`);
  }
  const app = publicOrigin(process.env.TICKMARK_PUBLIC_URL);
  const site = publicOrigin(process.env.TICKMARK_MARKETING_URL);
  if (app) html = html.replaceAll('href="#hosted-access" data-app-signin', `href="${app}/login" data-app-signin rel="noreferrer"`);
  if (site) html = html.replace('<!-- Optional canonical metadata is added by tools/build-marketing.mjs. -->',
    `<link rel="canonical" href="${site}/">\n<meta property="og:url" content="${site}/">`);
  const out = resolve(process.argv[2] ?? 'tmp-marketing');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'index.html'), html);
  console.log(`Standalone marketing page written to ${out}; hosted sign-in ${app ? 'configured' : 'not configured'}.`);
}
