// Prints a freshness report for every backup layer. Exit code 1 if anything required is missing or stale.
//   node scripts/backup/verify-backups.mjs [--max-age-hours 36]
import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_ROOT, MAIN_REPO, GITHUB_REPO, git, gitTry, readStatus } from './lib.mjs'

const i = process.argv.indexOf('--max-age-hours')
const maxH = i > 0 ? Number(process.argv[i + 1]) : 36
const rows = []
const add = (layer, ok, note) => rows.push({ layer, ok, note })
const age = (iso) => (Date.now() - Date.parse(iso)) / 36e5
const url = `https://github.com/${GITHUB_REPO}.git`

const mirror = path.join(BACKUP_ROOT, 'git', 'boe-task-management.git')
if (!fs.existsSync(mirror)) add('code mirror', false, 'missing - run backup-code.mjs')
else {
  const ghMain = gitTry(MAIN_REPO, 'ls-remote', url, 'refs/heads/main').out.split(/\s/)[0]
  const has = ghMain && gitTry(mirror, 'cat-file', '-e', ghMain + '^{commit}').ok
  add('GitHub main is inside the local mirror', !!has, has ? `main ${ghMain.slice(0, 8)} present` : `GitHub main ${String(ghMain).slice(0, 8)} NOT in mirror - run backup-all`)
  const localHeads = git(MAIN_REPO, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads').split('\n').filter(Boolean)
  const missing = localHeads.filter((l) => !gitTry(mirror, 'cat-file', '-e', l.split(' ')[0] + '^{commit}').ok)
  add('every local branch tip is in the mirror', missing.length === 0, missing.length ? `${missing.length} tip(s) missing, e.g. ${missing[0]}` : `${localHeads.length} branches covered`)
}
const code = readStatus('code-full')
add('full code backup (bundle+memory+env)', !!code && age(code.at) <= maxH, code ? `${age(code.at).toFixed(1)} h old` : 'never run')
const bdir = path.join(BACKUP_ROOT, 'bundles')
const latestBundle = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith('.bundle')).sort().slice(-1)[0] : null
if (latestBundle) add('latest bundle verifies', gitTry(MAIN_REPO, 'bundle', 'verify', path.join(bdir, latestBundle)).ok, latestBundle)
else add('latest bundle verifies', false, 'no bundle')
const db = readStatus('database')
add('database + storage export', !!db && db.ok && age(db.at) <= maxH, db ? `${age(db.at).toFixed(1)} h old, ${db.tables} tables, ${db.totalRows} rows, ${db.errors} errors` : 'never run')
const hp = gitTry(MAIN_REPO, 'config', '--get', 'core.hooksPath').out
add('git hooks installed', hp.toLowerCase().includes('backups/hooks'), hp || 'core.hooksPath not set - run install-backup-system.mjs')
const second = readStatus('all')
add('second copy (BOE_BACKUP_COPY_TO)', !!second?.copiedTo, second?.copiedTo || 'not configured - recommended (external drive / OneDrive)')

for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.layer.padEnd(42)} ${r.note}`)
const bad = rows.filter((r) => !r.ok && !r.layer.startsWith('second copy'))
console.log(bad.length ? `\n${bad.length} layer(s) need attention.` : '\nAll required layers are fresh.')
process.exit(bad.length ? 1 : 0)
