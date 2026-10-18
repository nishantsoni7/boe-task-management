// One command for a complete backup. Run it after EVERY merge to main (see docs/app-context/02_MASTER_INSTRUCTION_SHEET.md).
//   node scripts/backup/backup-all.mjs               code (full) + database + storage
//   node scripts/backup/backup-all.mjs --skip-db     code only
//   node scripts/backup/backup-all.mjs --no-storage  skip the storage mirror
//   BOE_BACKUP_COPY_TO=<folder>  also copies the newest snapshots to a second location (external drive / OneDrive)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKUP_ROOT, assertNotDesktop, ensureDir, log, writeStatus } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const run = (script, extra = []) => spawnSync(process.execPath, [path.join(here, script), ...extra], { stdio: 'inherit' }).status === 0
const res = { code: run('backup-code.mjs', args.includes('--no-github') ? ['--no-github'] : []) }
if (!args.includes('--skip-db')) res.database = run('backup-database.mjs', args.includes('--no-storage') ? ['--no-storage'] : [])

const copyTo = process.env.BOE_BACKUP_COPY_TO
if (copyTo) {
  assertNotDesktop(copyTo)
  const dest = ensureDir(path.join(copyTo, 'boe-task-management'))
  const newest = (dir, re) => {
    const d = path.join(BACKUP_ROOT, dir)
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => re.test(f)).sort().slice(-1)[0] : null
  }
  for (const [dir, re] of [['bundles', /\.bundle$/], ['database', /^\d/], ['secrets', /\.enc$/], ['memory', /^\d/]]) {
    const n = newest(dir, re)
    if (!n) continue
    fs.cpSync(path.join(BACKUP_ROOT, dir, n), path.join(dest, dir, n), { recursive: true })
    if (dir === 'bundles') fs.cpSync(path.join(BACKUP_ROOT, dir, n + '.sha256'), path.join(dest, dir, n + '.sha256'))
  }
  fs.cpSync(path.join(BACKUP_ROOT, 'git'), path.join(dest, 'git'), { recursive: true })
  // Uploaded files: cumulative mirror, copied in full (skips files already present with the same size).
  const sroot = path.join(BACKUP_ROOT, 'storage')
  if (fs.existsSync(sroot)) {
    fs.cpSync(sroot, path.join(dest, 'storage'), { recursive: true, filter: (src, dst) => !(fs.existsSync(dst) && fs.statSync(src).isFile() && fs.statSync(dst).size === fs.statSync(src).size) })
  }
  res.copiedTo = dest
}
writeStatus('all', res)
log('backup-all finished', JSON.stringify(res))
process.exit(res.code === false || res.database === false ? 1 : 0)
