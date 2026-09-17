/**
 * The entry point. One process, one file of data, one port.
 */
import { dirname, join } from 'node:path';

import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { mailerFromEnvironment } from './mailer.js';

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.TICKMARK_DATA ?? 'data/tickmark.db';

// Blobs live beside the database by default, so that "back up the data directory" is the
// whole backup instruction and not a sentence with a second path in it.
const blobDir = process.env.TICKMARK_BLOBS ?? join(dirname(dataFile), 'blobs');
const maxUploadBytes = Number(process.env.TICKMARK_MAX_UPLOAD ?? 25 * 1024 * 1024);

const db = openDatabase(dataFile);

// Sending is optional, and a missing configuration is reported rather than fatal: drafting a
// reminder works with no mail server at all, and the page says so.
let mailer = null;
try {
  mailer = mailerFromEnvironment();
} catch (error) {
  console.error(`tickmark: mail is misconfigured, so reminders cannot be sent — ${error.message}`);
}

const server = createApp(db, { blobDir, maxUploadBytes, mailer });

server.listen(port, () => {
  console.log(`tickmark listening on http://localhost:${port}`);
  console.log(`database: ${dataFile}`);
  console.log(`uploads:  ${blobDir}`);
  console.log(`mail:     ${mailer ? mailer.describe() : 'not configured — reminders are drafted, not sent'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}