/**
 * The entry point. One process, one file of data, one port.
 */
import { dirname, join } from 'node:path';

import { openDatabase } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.TICKMARK_DATA ?? 'data/tickmark.db';

// Blobs live beside the database by default, so that "back up the data directory" is the
// whole backup instruction and not a sentence with a second path in it.
const blobDir = process.env.TICKMARK_BLOBS ?? join(dirname(dataFile), 'blobs');
const maxUploadBytes = Number(process.env.TICKMARK_MAX_UPLOAD ?? 25 * 1024 * 1024);

const db = openDatabase(dataFile);
const server = createApp(db, { blobDir, maxUploadBytes });

server.listen(port, () => {
  console.log(`tickmark listening on http://localhost:${port}`);
  console.log(`database: ${dataFile}`);
  console.log(`uploads:  ${blobDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}