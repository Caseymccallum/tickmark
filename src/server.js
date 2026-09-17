/**
 * The entry point. One process, one file of data, one port.
 */
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.TICKMARK_DATA ?? 'data/tickmark.db';

const db = openDatabase(dataFile);
const server = createApp(db);

server.listen(port, () => {
  console.log(`tickmark listening on http://localhost:${port}`);
  console.log(`data: ${dataFile}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}