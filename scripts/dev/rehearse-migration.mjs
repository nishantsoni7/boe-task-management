// Builds a rehearsal file: begin; <migration>; <checks>; rollback;
// Nothing here talks to a database. Usage:
//   node scripts/dev/rehearse-migration.mjs <migration.sql> <checks.sql> <out.sql>
import { readFileSync, writeFileSync } from 'node:fs'

const [migrationPath, checksPath, outPath] = process.argv.slice(2)
if (!migrationPath || !checksPath || !outPath) {
  console.error('usage: node scripts/dev/rehearse-migration.mjs <migration.sql> <checks.sql> <out.sql>')
  process.exit(2)
}
const clean = p => readFileSync(p, 'utf8').replace(/\r/g, '')
// join, not String.replace: SQL is full of "$$", which replace() would mangle.
writeFileSync(outPath, [
  'begin;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '60s';",
  clean(migrationPath),
  clean(checksPath),
  'rollback;',
  '',
].join('\n'))
console.log('wrote', outPath)
