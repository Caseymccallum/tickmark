import { openDatabase } from '../src/db.js';

const db = openDatabase();
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
for (let i = 0; i < 1000; i += 1) db.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`);

const sql = 'SELECT id, v FROM t WHERE id = ?';
const runs = 20000;

let at = Date.now();
for (let i = 0; i < runs; i += 1) db.prepare(sql).get((i % 1000) + 1);
const fresh = Date.now() - at;

const cached = db.prepare(sql);
at = Date.now();
for (let i = 0; i < runs; i += 1) cached.get((i % 1000) + 1);
const reused = Date.now() - at;

console.log(`${runs} reads`);
console.log(`  prepare-and-run each time: ${fresh} ms`);
console.log(`  prepared once and reused:  ${reused} ms`);
console.log(`  re-parsing is ${(fresh / reused).toFixed(1)}x the work`);
db.close();
