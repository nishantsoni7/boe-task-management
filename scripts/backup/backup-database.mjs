// Read-only export of the live Supabase project: every public table (JSONL.gz, encrypted),
// auth users (no passwords), the REST schema snapshot, and a mirror of all Storage buckets.
// Uses the service-role key from .env.local over HTTPS — needs no Docker, psql or pg_dump,
// except for the few tables the service role cannot read (optional pg_dump step, see 2b).
// Writes only to the backup folder; never prints row data.
//   node backup-database.mjs                 tables + auth + storage
//   node backup-database.mjs --no-storage    skip the (large) storage mirror
//   node backup-database.mjs --plain         do not encrypt table files
//   BOE_ENV_FILE=<path> overrides the .env.local location
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import { BACKUP_ROOT, MAIN_REPO, countCopyRows, encryptFile, ensureDir, loadEnvFile, log, prune, sha256File, stamp, writeStatus } from './lib.mjs'

const noStorage = process.argv.includes('--no-storage')
const plain = process.argv.includes('--plain')
// Production keys live in Vercel; .env.local may hold OLD (disabled) legacy keys. Prefer a dedicated file.
const dedicated = path.join(path.dirname(BACKUP_ROOT), '.env.backup')
const envFile = process.env.BOE_ENV_FILE || (fs.existsSync(dedicated) ? dedicated : path.join(MAIN_REPO, '.env.local'))
if (!fs.existsSync(envFile)) throw new Error(`env file not found: ${envFile} (set BOE_ENV_FILE)`)
const env = loadEnvFile(envFile)
const base = (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!base || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in env file')
// New-style secret keys (sb_secret_...) are not JWTs: apikey header only. Legacy JWT keys also need Bearer.
const H = key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` }
const projectRef = new URL(base).hostname.split('.')[0]

async function api(url, init = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...H, ...(init.headers || {}) } })
      if (res.status >= 500 || res.status === 429) throw new Error('HTTP ' + res.status)
      return res
    } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 800 * i)) }
  }
}

const ts = stamp()
const outDir = ensureDir(path.join(BACKUP_ROOT, 'database', ts))
const manifest = { project: projectRef, startedAt: new Date().toISOString(), encrypted: !plain, tables: {}, errors: [] }

// 1 ── schema snapshot + table list from PostgREST's OpenAPI document ──────────
const specRes = await api(`${base}/rest/v1/`, { headers: { Accept: 'application/openapi+json' } })
const spec = await specRes.json().catch(() => ({}))
if (!specRes.ok || !(spec.definitions || spec.components?.schemas)) {
  throw new Error(`Cannot read the schema (HTTP ${specRes.status}): ${spec.message || ''} ${spec.hint || ''}
Put a valid SUPABASE_SERVICE_ROLE_KEY (the sb_secret_... key) in ${dedicated} with NEXT_PUBLIC_SUPABASE_URL.`)
}
fs.writeFileSync(path.join(outDir, 'rest-openapi.json'), JSON.stringify(spec))
const defs = spec.definitions || spec.components?.schemas || {}
const tables = Object.keys(defs).sort()
const pkOf = (name) => Object.entries(defs[name].properties || {}).filter(([, p]) => /Primary Key/i.test(p.description || '')).map(([c]) => c)
log(`project ${projectRef}: ${tables.length} exposed relations`)

// 2 ── tables ─────────────────────────────────────────────────────────────────
function save(name, buf) {
  const gz = path.join(outDir, name + '.jsonl.gz')
  fs.writeFileSync(gz, zlib.gzipSync(buf))
  const sha = sha256File(gz)
  if (!plain) { encryptFile(gz, gz + '.enc'); fs.rmSync(gz) }
  return sha
}
for (const t of tables) {
  try {
    const pk = pkOf(t); const order = pk.length ? `&order=${pk.map((c) => c + '.asc').join(',')}` : ''
    const PAGE = 1000; let from = 0; let total = null; const lines = []
    for (;;) {
      const res = await api(`${base}/rest/v1/${encodeURIComponent(t)}?select=*${order}`, { headers: { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact' } })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
      const rows = await res.json()
      total = Number((res.headers.get('content-range') || '').split('/')[1])
      for (const r of rows) lines.push(JSON.stringify(r))
      if (rows.length < PAGE) break
      from += PAGE
    }
    const sha = save(t, Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')))
    manifest.tables[t] = { rows: lines.length, reportedCount: Number.isFinite(total) ? total : null, sha256OfGz: sha, hasPk: pk.length > 0 }
    if (Number.isFinite(total) && total !== lines.length) manifest.errors.push(`${t}: exported ${lines.length} but server reports ${total}`)
  } catch (e) {
    // 42501 = the service role is deliberately not granted SELECT. Not a failure of the backup; listed so nobody assumes it is covered.
    if (/HTTP 403/.test(e.message) && /42501/.test(e.message)) { (manifest.unreadable ??= []).push(t); manifest.tables[t] = { unreadable: true } }
    else { manifest.errors.push(`${t}: ${e.message}`); manifest.tables[t] = { error: e.message } }
  }
}

// 2b ── tables the service role is deliberately denied: direct pg_dump ───────────
// Needs BACKUP_DATABASE_URL (Supabase session-pooler URI) in the env file and Docker running.
// BACKUP_PG_IMAGE picks the Docker image (default postgres:17; its pg_dump must be at least the server's
// major version, 17 today). Use an image that is already on this machine to avoid a download.
// Anything that goes wrong here is a warning, not a backup failure: the tables simply stay
// listed as NOT COVERED (Supabase platform backups still hold them).
// finance_received_payments and finance_payment_destinations are VIEWS over tables that are exported
// (orders, order_submissions, users, finance_payment_requests, finance_payment_allocations,
// finance_payment_allocation_intents), so they are rebuilt from those, not dumped. A view fed to pg_dump -t
// has no CREATE TABLE, which would make the whole step look failed. Checked against production 2026-10-28.
const VIEWS = new Set(['finance_received_payments', 'finance_payment_destinations'])
// The views are not "uncovered": their data lives in the exported tables above. Say so instead of crying wolf.
const viewsHere = (manifest.unreadable ?? []).filter((t) => VIEWS.has(t))
if (viewsHere.length) {
  manifest.viewsRebuilt = viewsHere
  manifest.unreadable = manifest.unreadable.filter((t) => !VIEWS.has(t))
  log(`views rebuilt from exported tables (not dumped): ${viewsHere.join(', ')}`)
}
const toDump = (manifest.unreadable ?? []).filter((t) => !VIEWS.has(t))
if (toDump.length) {
  const dbUrl = env.BACKUP_DATABASE_URL
  if (!dbUrl) log(`pg_dump skipped: BACKUP_DATABASE_URL is not set in ${envFile}`)
  else {
    const image = env.BACKUP_PG_IMAGE || 'postgres:17'
    const args = ['run', '--rm', '-e', 'BACKUP_DATABASE_URL', '--entrypoint', 'sh', image, '-c',
      `pg_dump --no-owner --no-privileges ${toDump.map((t) => `-t public.${t}`).join(' ')} "$BACKUP_DATABASE_URL"`]
    const r = spawnSync('docker', args, { env: { ...process.env, BACKUP_DATABASE_URL: dbUrl }, maxBuffer: 1024 * 1024 * 1024 })
    const sql = r.stdout || Buffer.alloc(0)
    const text = sql.toString('utf8')
    const missing = toDump.filter((t) => !text.includes(`CREATE TABLE public.${t} `))
    if (r.status !== 0 || missing.length) {
      log(`pg_dump FAILED, tables stay NOT COVERED: ${(r.stderr || '').toString().replace(dbUrl, '<url>').trim().split('\n').slice(-2).join(' | ') || 'missing ' + missing.join(', ')}`)
    } else {
      // Row counts from the COPY blocks, so the manifest records what was captured.
      const rows = Object.fromEntries(toDump.map((t) => [t, countCopyRows(text, t) ?? 0]))
      const gz = path.join(outDir, 'pg-dump-restricted-tables.sql.gz')
      fs.writeFileSync(gz, zlib.gzipSync(sql))
      const sha = sha256File(gz)
      if (!plain) { encryptFile(gz, gz + '.enc'); fs.rmSync(gz) }
      manifest.pgDump = { tables: rows, sha256OfGz: sha, file: path.basename(gz) + (plain ? '' : '.enc') }
      for (const t of toDump) manifest.tables[t] = { rows: rows[t], viaPgDump: true }
      manifest.unreadable = manifest.unreadable.filter((t) => !toDump.includes(t))
      log(`pg_dump OK (${image}): ${toDump.map((t) => `${t} (${rows[t]} rows)`).join(', ')}`)
    }
  }
}

// 3 ── auth users (profile data only; Supabase never exposes password hashes) ──
try {
  const users = []
  for (let page = 1; ; page++) {
    const ar = await api(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`)
    if (!ar.ok) throw new Error('HTTP ' + ar.status)
    const j = await ar.json()
    users.push(...(j.users || [])); if (!j.users || j.users.length < 1000) break
  }
  manifest.authUsers = { rows: users.length, sha256OfGz: save('_auth_users', Buffer.from(users.map((u) => JSON.stringify(u)).join('\n') + '\n')) }
} catch (e) { manifest.errors.push('auth users: ' + e.message) }

// 4 ── storage mirror (incremental: unchanged size => skipped) ─────────────────
if (!noStorage) {
  const sroot = ensureDir(path.join(BACKUP_ROOT, 'storage'))
  manifest.storage = { buckets: {} }
  const br = await api(`${base}/storage/v1/bucket`)
  const buckets = await br.json()
  if (!br.ok || !Array.isArray(buckets)) throw new Error('cannot list storage buckets: HTTP ' + br.status)
  fs.writeFileSync(path.join(outDir, 'storage-buckets.json'), JSON.stringify(buckets))
  async function listAll(bucket, prefix) {
    const found = []
    for (let offset = 0; ; offset += 1000) {
      const items = await (await api(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) })).json()
      if (!Array.isArray(items)) throw new Error('list failed for ' + bucket)
      for (const it of items) {
        if (it.id === null) found.push(...(await listAll(bucket, prefix ? `${prefix}/${it.name}` : it.name)))
        else found.push({ path: prefix ? `${prefix}/${it.name}` : it.name, size: it.metadata?.size ?? null })
      }
      if (items.length < 1000) break
    }
    return found
  }
  for (const b of buckets) {
    const st = { objects: 0, downloaded: 0, skipped: 0, bytes: 0, failed: 0 }
    try {
      for (const o of await listAll(b.name, '')) {
        st.objects++
        const dest = path.join(sroot, b.name, ...o.path.split('/'))
        if (o.size != null && fs.existsSync(dest) && fs.statSync(dest).size === o.size) { st.skipped++; continue }
        try {
          const res = await api(`${base}/storage/v1/object/authenticated/${encodeURIComponent(b.name)}/${o.path.split('/').map(encodeURIComponent).join('/')}`)
          if (!res.ok) throw new Error('HTTP ' + res.status)
          fs.mkdirSync(path.dirname(dest), { recursive: true }); const buf = Buffer.from(await res.arrayBuffer()); fs.writeFileSync(dest, buf)
          st.downloaded++; st.bytes += buf.length
        } catch (e) { st.failed++; manifest.errors.push(`storage ${b.name}/${o.path}: ${e.message}`) }
      }
    } catch (e) { manifest.errors.push(`storage bucket ${b.name}: ${e.message}`) }
    manifest.storage.buckets[b.name] = { public: b.public, ...st }
  }
}

manifest.finishedAt = new Date().toISOString()
manifest.totalRows = Object.values(manifest.tables).reduce((n, t) => n + (t.rows || 0), 0)
fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
prune(path.join(BACKUP_ROOT, 'database'), /^\d/, 14)
const ok = manifest.errors.length === 0 && Object.keys(manifest.tables).length > 0
writeStatus('database', { ok, snapshot: ts, tables: Object.keys(manifest.tables).length, totalRows: manifest.totalRows, errors: manifest.errors.length, unreadable: manifest.unreadable ?? [], viaPgDump: Object.keys(manifest.pgDump?.tables ?? {}), project: projectRef })
if (manifest.unreadable?.length) log(`NOT COVERED (permission denied for the service role): ${manifest.unreadable.join(', ')} - rely on Supabase platform backups for these`)
log(`database backup ${ok ? 'OK' : 'FINISHED WITH ' + manifest.errors.length + ' ERROR(S)'} — ${Object.keys(manifest.tables).length} tables, ${manifest.totalRows} rows -> ${outDir}`)
if (!ok) { console.error(manifest.errors.slice(0, 15).join('\n')); process.exitCode = 1 }
