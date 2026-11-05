// One backup-all at a time. Two overlapping runs on 2026-11-05 let the later (failed) one overwrite status/database.json after a clean run.
// The lock is a file holding the process id and start time. A crashed run leaves a file behind, so a holder only counts when its process
// is really alive, and never after MAX_AGE_MS (Windows reuses process ids; a real run takes about 9 minutes).
import fs from 'node:fs'
import path from 'node:path'

export const MAX_AGE_MS = 6 * 60 * 60 * 1000

export const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } // EPERM = exists, not ours
}

function readHolder(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } // unreadable/half-written counts as stale
}

// Returns { ok: true } after taking the lock, or { ok: false, holder } when a live run holds it. Writes nothing else when refused.
export function acquireLock(file, { alive = pidAlive, now = Date.now, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), command: process.argv.slice(1).join(' ') }), { flag: 'wx' })
      return { ok: true }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const holder = readHolder(file)
    const age = holder ? now() - Date.parse(holder.startedAt) : Infinity
    if (holder && Number.isInteger(holder.pid) && age < MAX_AGE_MS && alive(holder.pid)) return { ok: false, holder }
    try { fs.rmSync(file) } catch { /* another run removed it first */ }
  }
  return { ok: false, holder: readHolder(file) }
}

// Removes the lock only when it is still ours.
export function releaseLock(file, pid = process.pid) {
  if (readHolder(file)?.pid === pid) try { fs.rmSync(file) } catch { /* already gone */ }
}

// Takes the lock for the life of this process: released on any exit (normal, thrown error, process.exit) and on Ctrl+C / task stop.
// A hard kill cannot be caught; the stale-lock check above covers it.
export function holdLockUntilExit(file, opts) {
  const got = acquireLock(file, opts)
  if (!got.ok) return got
  process.on('exit', () => releaseLock(file, opts?.pid))
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(130))
  return got
}
