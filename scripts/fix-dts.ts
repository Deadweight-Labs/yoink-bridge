// tsc rewrites relative `.ts` imports to `.js` in the emitted JavaScript but
// not in declarations; this does the same for dist/**/*.d.ts, so consumers
// without `allowImportingTsExtensions` can read them. Run by `npm run build`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const relativeTs = /(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g;

for (const entry of readdirSync('dist', { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
  const path = join(entry.parentPath, entry.name);
  const source = readFileSync(path, 'utf8');
  const fixed = source.replace(relativeTs, '$1$2$3.js$2');
  if (fixed !== source) writeFileSync(path, fixed);
}
