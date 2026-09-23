/**
 * The entry point. One process, one file of data, one port.
 *
 * Set MULTI_TENANT=1 and the same code hosts many practices, one file each: the registry and the
 * pool in `src/tenancy/` take over and the single-tenant body below is not executed. The imports
 * are dynamic for exactly that reason — the single-tenant server should not load the tenancy
 * layer, and the multi-tenant server should not open a practice's database at startup.
 * See docs/saas.md.
 */
import { dirname, join } from 'node:path';

if (process.env.MULTI_TENANT === '1') {
  const { createSaasServer } = await import('./tenancy/entry.js');

  const port = Number(process.env.PORT ?? 3000);
  const dataDir = process.env.TICKMARK_DATA ?? 'data';

  const { server, registry, pool } = createSaasServer();
  server.listen(port, () => {
    console.log(`tickmark (multi-tenant) listening on http://localhost:${port}`);
    console.log(`registry: ${process.env.TICKMARK_REGISTRY ?? join(dataDir, 'saas.db')}`);
    console.log(`tenants:  ${process.env.TICKMARK_TENANTS ?? join(dataDir, 'tenants')}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        pool.closeAll();
        registry.close();
        process.exit(0);
      });
    });
  }
} else {
  const { openDatabase } = await import('./db.js');
  const { VERSION } = await import('./version.js');
  const { createApp } = await import('./app.js');
  const { mailerFromEnvironment } = await import('./mailer.js');

  const port = Number(process.env.PORT ?? 3000);
  const dataFile = process.env.TICKMARK_DATA ?? 'data/tickmark.db';

  // Blobs live beside the database by default, so that "back up the data directory" is the
  // whole backup instruction and not a sentence with a second path in it.
  const blobDir = process.env.TICKMARK_BLOBS ?? join(dirname(dataFile), 'blobs');
  const maxUploadBytes = Number(process.env.TICKMARK_MAX_UPLOAD ?? 25 * 1024 * 1024);
  // What one client link may store in total, and how many files it may hold. Both exist so that one client —
  // or one leaked link — cannot fill the disk, which would take the whole install down rather than failing
  // one upload. See docs/operations.md for what they are and when to raise them.
  const maxRequestBytes = Number(process.env.TICKMARK_MAX_REQUEST_BYTES ?? 2 * 1024 * 1024 * 1024);
  const maxRequestFiles = Number(process.env.TICKMARK_MAX_REQUEST_FILES ?? 500);

  const db = openDatabase(dataFile);

  // Sending is optional, and a missing configuration is reported rather than fatal: drafting a
  // reminder works with no mail server at all, and the page says so.
  let mailer = null;
  try {
    mailer = mailerFromEnvironment();
  } catch (error) {
    console.error(`tickmark: mail is misconfigured, so reminders cannot be sent — ${error.message}`);
  }

  const server = createApp(db, { blobDir, maxUploadBytes, maxRequestBytes, maxRequestFiles, mailer });

  server.listen(port, () => {
    console.log(`tickmark ${VERSION} listening on http://localhost:${port}`);
    console.log(`database: ${dataFile}`);
    console.log(`uploads:  ${blobDir}`);
    console.log(`mail:     ${mailer ? mailer.describe() : 'not configured — reminders are drafted, not sent'}`);
    // What the migrations did, if anything. An upgrade that changed the schema should say so where the operator
    // is already looking, because the alternative is finding out from a page that behaves oddly.
    const changed = [
      db.migratedKeys && `${db.migratedKeys} keys moved`,
      db.migratedColumns && `${db.migratedColumns} columns added`,
      db.migratedTenancy && `${db.migratedTenancy} rows adopted into practices`,
      db.migratedSession && `${db.migratedSession} obsolete columns removed`,
      db.migratedWrappings && `${db.migratedWrappings} key copies recorded`,
      db.migratedInvites && `${db.migratedInvites} invitations reshaped`,
      db.migratedUploads && `${db.migratedUploads} files reattached to their requests`,
    ].filter(Boolean);
    console.log(
      changed.length > 0
        ? `schema:   upgraded — ${changed.join(', ')}. Nothing was deleted; see docs/operations.md.`
        : 'schema:   up to date, no migration needed',
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}
