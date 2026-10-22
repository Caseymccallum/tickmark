import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DESIGN_TOKENS } from '../src/style.js';
import { escapeHtml } from '../src/views.js';
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
  const demoOrigin = publicOrigin(process.env.TICKMARK_PUBLIC_DEMO_URL);
  const demoApproved = process.env.TICKMARK_PUBLIC_DEMO_APPROVED === '1';
  if (process.env.TICKMARK_PUBLIC_DEMO_URL && !demoOrigin) {
    throw new Error('TICKMARK_PUBLIC_DEMO_URL must be one HTTPS origin, without credentials, path, query or fragment');
  }
  if (demoApproved && !demoOrigin) throw new Error('TICKMARK_PUBLIC_DEMO_APPROVED=1 requires a validated TICKMARK_PUBLIC_DEMO_URL');
  if (demoApproved && demoOrigin) {
    const fallback = '<!-- TICKMARK DEMO CTA START --><span class="btn" aria-disabled="true">Interactive demonstration coming soon</span><!-- TICKMARK DEMO CTA END -->';
    if (!html.includes(fallback)) throw new Error('Marketing page does not contain the expected gated demo CTA slot');
    html = html.replace(fallback,
      `<!-- TICKMARK DEMO CTA START --><a class="btn primary" href="${escapeHtml(demoOrigin)}/" rel="noreferrer">Open interactive demonstration</a><!-- TICKMARK DEMO CTA END -->`);
  }
  const app = publicOrigin(process.env.TICKMARK_PUBLIC_URL);
  const site = publicOrigin(process.env.TICKMARK_MARKETING_URL);
  if (app) html = html.replaceAll('href="#hosted-access" data-app-signin', `href="${escapeHtml(app)}/login" data-app-signin rel="noreferrer"`);
  if (site) html = html.replace('<!-- Optional canonical metadata is added by tools/build-marketing.mjs. -->',
    `<link rel="canonical" href="${escapeHtml(site)}/">\n<meta property="og:url" content="${escapeHtml(site)}/">`);
  const out = resolve(process.argv[2] ?? 'tmp-marketing');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'index.html'), html);
  console.log(`Standalone marketing page written to ${out}; hosted sign-in ${app ? 'configured' : 'not configured'}.`);
}
