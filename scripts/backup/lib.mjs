// Shared helpers for the BOE backup scripts. Node built-ins only (no npm install needed),
// so a copy of scripts/backup/ keeps working even when node_modules is gone.
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()
export const DEV_ROOT = process.env.BOE_DEV_ROOT || path.join(HOME, 'BOE-Development')
export const BACKUP_ROOT = process.env.BOE_BACKUP_ROOT || path.join(DEV_ROOT, 'backups', 'boe-task-management')
export const MAIN_REPO = process.env.BOE_MAIN_REPO || path.join(DEV_ROOT, 'repositories', 'boe-task-management')
export const MEMORY_DIR = process.env.BOE_MEMORY_DIR || path.join(HOME, '.claude', 'projects', 'C--Users-Lenovo-BOE-Development-repositories-boe-task-management', 'memory')
export const GITHUB_REPO = 'nishantsoni7/boe-task-management'

// Hard guard from the owner's standing rule: never write dev output to a Desktop.
const FORBIDDEN = [path.join(HOME, 'Desktop'), path.join(HOME, 'OneDrive', 'Desktop')].map((p) => p.toLowerCase())
export function assertNotDesktop(p) {
  const abs = path.resolve(p).toLowerCase()
  if (FORBIDDEN.some((f) => abs === f || abs.startsWith(f + path.sep))) throw new Error(`Refusing to write to a Desktop path: ${p}`)
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
export const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)
export function ensureDir(p) { assertNotDesktop(p); fs.mkdirSync(p, { recursive: true }); return p }

// Git hooks export GIT_DIR/GIT_INDEX_FILE etc.; left in place they redirect every git call here into the hooked repository.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|QUARANTINE_PATH)$/.test(k)))

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
export function gitTry(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

export function sha256File(p) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(1 << 20)
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)) } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

// Keep the newest `keep` entries whose names match `re`, delete older ones.
export function prune(dir, re, keep) {
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir).filter((f) => re.test(f)).sort().reverse()
  for (const f of files.slice(keep)) fs.rmSync(path.join(dir, f), { recursive: true, force: true })
}

// ── Encryption (AES-256-GCM, scrypt key from a passphrase) ───────────────────
// The passphrase comes from BOE_BACKUP_PASSPHRASE, or from a key file created on first use.
export function passphrase() {
  if (process.env.BOE_BACKUP_PASSPHRASE) return process.env.BOE_BACKUP_PASSPHRASE
  const keyFile = path.join(path.dirname(BACKUP_ROOT), '.keys', 'backup-passphrase.txt')
  if (!fs.existsSync(keyFile)) {
    ensureDir(path.dirname(keyFile))
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 })
    log(`Created backup passphrase file ${keyFile} — COPY ITS CONTENT TO YOUR PASSWORD MANAGER NOW. Without it encrypted backups cannot be opened.`)
  }
  return fs.readFileSync(keyFile, 'utf8').trim()
}
export function encryptFile(src, dest) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase(), salt, 32)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(fs.readFileSync(src)), c.final()])
  fs.writeFileSync(dest, Buffer.concat([Buffer.from('BOEENC1'), salt, iv, c.getAuthTag(), enc]))
}
export function decryptFile(src, dest) {
  const b = fs.readFileSync(src)
  if (b.subarray(0, 7).toString() !== 'BOEENC1') throw new Error('not a BOE encrypted file')
  const salt = b.subarray(7, 23), iv = b.subarray(23, 35), tag = b.subarray(35, 51)
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase(), salt, 32), iv)
  d.setAuthTag(tag)
  fs.writeFileSync(dest, Buffer.concat([d.update(b.subarray(51)), d.final()]))
}

// ── .env loader (no dependency) ──────────────────────────────────────────────
export function loadEnvFile(p) {
  const env = {}
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return env
}

export function writeStatus(name, data) {
  const dir = ensureDir(path.join(BACKUP_ROOT, 'status'))
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2))
}
export function readStatus(name) {
  try { return JSON.parse(fs.readFileSync(path.join(BACKUP_ROOT, 'status', `${name}.json`), 'utf8')) } catch { return null }
}

// Rows that a pg_dump holds for one table: the lines between its "COPY public.<table> (...) FROM stdin;" line and the
// terminating "\\." line. Line-based on purpose: an empty table's block is only those two lines, and a pattern that
// searches for the terminator can run on into the NEXT table's data and report rows that are not there.
// Returns null when the dump has no COPY block for the table at all.
export function countCopyRows(sql, table) {
  const lines = sql.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`COPY public.${table} (`))
  if (start < 0) return null
  let n = 0
  for (let i = start + 1; i < lines.length && lines[i] !== '\\.'; i++) n++
  return n
}
