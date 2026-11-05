/**
 * Validates and zips the agent skill for upload to skill marketplaces.
 * Usage: npm run skill:pack  ->  skill-dist/frontend-bug-investigator.zip
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkill, writeZip } from './skill-package.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'frontend-bug-investigator');

const { name, files, problems } = validateSkill(SKILL_DIR);
if (problems.length || !name) {
  console.error('Skill package is not valid:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const outFile = path.join(ROOT, 'skill-dist', `${name}.zip`);
writeZip(files, name, outFile);
const bytes = files.reduce((sum, f) => sum + f.size, 0);
console.log(
  `Packed ${files.length} files (${(bytes / 1024).toFixed(1)} KB uncompressed) into ${path.relative(ROOT, outFile)}:`,
);
for (const file of files) console.log(`  ${name}/${file.relativePath}`);
