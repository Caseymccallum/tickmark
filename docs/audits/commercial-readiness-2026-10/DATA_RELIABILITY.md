# Data reliability and recovery

## Implemented

SQLite WAL is backed up with VACUUM INTO, then blobs are copied and manifest written last. Verification opens the copy and checks every referenced blob exists. Fleet backup includes tenant directories and registry. Tests back up live databases, restore, and decrypt a document from restored data, including hosted fleet tests. Restore is manual by design and rollback means restoring a verified pre-upgrade copy.

Uploads spool to disk, rename under generated ID, then insert DB row. Crash between rename and row insert leaves orphan data; spool crash may leave .incoming. This is storage waste, not observed missing-document loss.

## Exposures

- 25 MB/file and 2 GB/500 files per request, but no tenant/global disk quota; full shared disk can stop all tenants.
- No backup schedule, off-host destination, alert or retention automation is provisioned.
- Backup holds registry emails/session hashes, readable metadata, wrapped keys and encrypted files; protect it.
- Restore tests prove mechanics, not production copy, recovery time or recovery point.
- No customer export/deletion/backup expiry lifecycle; tenant delete not implemented.
- Fleet tenant snapshots and registry are individually consistent but not one atomic fleet snapshot.
- Re-encryption and backup overlap may leave DB row pointing at absent file; docs warn against overlap.
- No duplicate-upload idempotency; no distributed locking/replica protocol.

Before pilot, schedule/alert off-host backup, protect backup access, rehearse restore on clean host, decrypt synthetic sample and record recovery time. Set aggregate quota and storage alerts before paid public service.
