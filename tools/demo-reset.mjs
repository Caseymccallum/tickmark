import { removeDemoDirectory } from './demo-safety.mjs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npm run demo:reset -- "<exact demo data path>"');
  process.exitCode = 2;
} else {
  try {
    removeDemoDirectory(path);
    console.log(`Removed the marked Tickmark demo directory: ${path}`);
  } catch (error) {
    console.error(`Demo reset refused: ${error.message}`);
    process.exitCode = 1;
  }
}
