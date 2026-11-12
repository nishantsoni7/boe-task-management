// One command for a complete backup. The 9:30 pm task runs it and that covers every merge of the day: do NOT run it after a merge (see docs/app-context/02_MASTER_INSTRUCTION_SHEET.md, section 8).
//   node scripts/backup/backup-all.mjs               code (full) + database + storage
//   node scripts/backup/backup-all.mjs --skip-db     code only
//   node scripts/backup/backup-all.mjs --no-storage  skip the storage mirror
//   BOE_BACKUP_COPY_TO=<folder>  also copies the newest snapshots to a second location (external drive / OneDrive)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKUP_ROOT, assertNotDesktop, copyGitMirror, copyMissing, ensureDir, log, readStatus, writeStatus } from './lib.mjs'
import { holdLockUntilExit } from './lock.mjs'

// Only one backup-all at a time (status/backup-all.lock). A refused run touches no status file. Quick git-hook runs are not locked.
const lock = holdLockUntilExit(path.join(BACKUP_ROOT, 'status', 'backup-all.lock'))
if (!lock.ok) {
  console.error(`backup-all is already running (process ${lock.holder?.pid}, since ${lock.holder?.startedAt}). Not starting a second one; wait for it to finish.`)
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const startedAt = new Date().toISOString()
const run = (script, extra = []) => spawnSync(process.execPath, [path.join(here, script), ...extra], { stdio: 'inherit' }).status === 0
const res = { code: run('backup-code.mjs', args.includes('--no-github') ? ['--no-github'] : []) }
if (!args.includes('--skip-db')) res.database = run('backup-database.mjs', args.includes('--no-storage') ? ['--no-storage'] : [])

// Only a plain run that fully succeeded counts: a partial one leaves its merges on the waiting list (pending-backups.mjs),
// and so does anything merged after this run began. Recorded before the second copy, because a failing external drive
// does not undo the backup itself.
if (!args.length && res.code && res.database && readStatus('code-full')?.steps?.mirrorGithub === 'ok') writeStatus('covered', { through: startedAt })

const copyTo = process.env.BOE_BACKUP_COPY_TO
if (copyTo) {
  assertNotDesktop(copyTo)
  const dest = ensureDir(path.join(copyTo, 'boe-task-management'))
  const newest = (dir, re) => {
    const d = path.join(BACKUP_ROOT, dir)
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => re.test(f)).sort().slice(-1)[0] : null
  }
  for (const [dir, re] of [['bundles', /\.bundle$/], ['database', /^\d/], ['secrets', /\.enc$/], ['memory', /^\d/], ['projects', /^\d/]]) {
    const n = newest(dir, re)
    if (!n) continue
    copyMissing(path.join(BACKUP_ROOT, dir, n), path.join(dest, dir, n))
    if (dir === 'bundles') fs.cpSync(path.join(BACKUP_ROOT, dir, n + '.sha256'), path.join(dest, dir, n + '.sha256'))
  }
  copyGitMirror(path.join(BACKUP_ROOT, 'git', 'boe-task-management.git'), path.join(dest, 'git', 'boe-task-management.git'))
  // Uploaded files: cumulative mirror, copied in full (skips files already present with the same size).
  const sroot = path.join(BACKUP_ROOT, 'storage')
  if (fs.existsSync(sroot)) {
    copyMissing(sroot, path.join(dest, 'storage'))
  }
  res.copiedTo = dest
  writeStatus('second-copy', { path: dest })
}
writeStatus('all', res)
log('backup-all finished', JSON.stringify(res))
process.exit(res.code === false || res.database === false ? 1 : 0)
