#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { restorePracticeExport } from '../src/tenancy/practice-export.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    email: { type: 'string' },
    'password-file': { type: 'string' },
    confirm: { type: 'string' },
  },
});
if (!values.from || !values.to || !values.email || !values['password-file'] || !values.confirm) {
  throw new Error('usage: node tools/restore-tenant-export.mjs --from <export-directory> --to <new-data-directory> --email <exported-owner> --password-file <new-password-file> --confirm <tenant-id>');
}
const ownerPassword = (await readFile(values['password-file'], 'utf8')).split(/\r?\n/)[0];
const restored = await restorePracticeExport({
  from: values.from,
  to: values.to,
  ownerEmail: values.email,
  ownerPassword,
  confirmTenantId: values.confirm,
});
console.log(`Restored practice ${restored.tenantId}: ${restored.documents} encrypted documents into ${restored.destination}.`);
console.log('Sign in with the new password and unlock documents using the practice passphrase or recovery key.');
