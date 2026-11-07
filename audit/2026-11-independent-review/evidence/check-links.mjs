import { readdirSync, readFileSync, existsSync } from 'node:fs';

const files = readdirSync('.').filter((f) => f.endsWith('.md'));
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const links = [...text.matchAll(/\]\(([A-Z_0-9]+\.md)\)/g)].map((m) => m[1]);
  const missing = links.filter((link) => !existsSync(link));
  const fences = (text.match(/```/g) || []).length;
  console.log(
    file.padEnd(38),
    'links=' + String(links.length).padEnd(3),
    'missing=' + (missing.length ? missing.join(',') : 'none').padEnd(6),
    'fencesEven=' + (fences % 2 === 0),
  );
}
