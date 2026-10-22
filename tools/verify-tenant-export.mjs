#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { verifyPracticeExport } from '../src/tenancy/practice-export.js';

const { values } = parseArgs({ options: { from: { type: 'string' } } });
if (!values.from) throw new Error('usage: node tools/verify-tenant-export.mjs --from <export-directory>');
const manifest = await verifyPracticeExport(values.from);
console.log(`Verified ${manifest.tenantId}: ${manifest.blobs.files} encrypted documents, ${manifest.blobs.bytes} bytes, format ${manifest.formatVersion}.`);
