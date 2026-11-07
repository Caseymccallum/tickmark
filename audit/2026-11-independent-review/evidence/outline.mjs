import { readFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  console.log(`=== ${file} ===`);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^#{2,3} /.test(line)) console.log(line);
  }
}
