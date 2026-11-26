// Finds the seed CSV files: the public demo file plus any private files in seed/local/ (git-ignored).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SeedFile } from './loadSeed.js';

export function seedFiles(root: string, mainCsv?: string): SeedFile[] {
  const main = mainCsv ?? path.join(root, 'seed/spir_seed.csv');
  const files: SeedFile[] = [{ name: path.relative(root, main), text: readFileSync(main, 'utf8') }];
  const localDir = path.join(root, 'seed/local');
  if (existsSync(localDir)) {
    for (const f of readdirSync(localDir).filter((x) => x.toLowerCase().endsWith('.csv')).sort()) {
      files.push({ name: `seed/local/${f}`, text: readFileSync(path.join(localDir, f), 'utf8') });
    }
  }
  return files;
}
