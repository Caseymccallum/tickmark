/**
 * Count the tables, and list them — because this project has got the number wrong three times.
 *
 *   node tools/tables.mjs
 *
 * The docs have claimed nine, twelve, fourteen and sixteen at various points, each time from memory. This reads
 * the schema out of a freshly created database instead, which is the only source that cannot be out of date.
 */
import { openDatabase } from '../src/db.js';

const db = openDatabase();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

console.log(`${tables.length} tables:`);
for (const name of tables) {
  const columns = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?)`).get(name).n;
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
  console.log(`  ${name.padEnd(20)} ${String(columns).padStart(2)} columns`);
}
db.close();
