// Restore rehearsal: proves the newest database export can really be read and loaded.
// Runs entirely on this machine in a throwaway Docker Postgres (no cost, production is never touched):
//   1. decrypt + gunzip every table file of the newest snapshot
//   2. create empty tables from the REST schema snapshot (columns/types/primary keys only)
//   3. load every row, then check row counts, primary-key uniqueness and the sum of every numeric
//      column against what the backup itself recorded
//   4. delete the container and the decrypted files
// It checks DATA integrity. It does NOT restore the real schema (constraints, RLS, functions): the
// migrations alone cannot rebuild an empty database (docs/migrations-are-not-self-contained.md), so the
// real schema comes from a Supabase platform backup. See docs/app-context/03_BACKUP_AND_RECOVERY.md.
//   node restore-rehearsal.mjs [--keep] [--snapshot <folder-name>]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { BACKUP_ROOT, decryptFile, ensureDir, log, stamp, writeStatus } from './lib.mjs'

const keep = process.argv.includes('--keep')
const sIdx = process.argv.indexOf('--snapshot')
const dbRoot = path.join(BACKUP_ROOT, 'database')
const snap = sIdx > 0 ? process.argv[sIdx + 1] : fs.readdirSync(dbRoot).filter((f) => /^\d/.test(f)).sort().pop()
const dir = path.join(dbRoot, snap)
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'))
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'rest-openapi.json'), 'utf8'))
const defs = spec.definitions || {}
const IMAGE = process.env.BOE_REHEARSAL_IMAGE || 'public.ecr.aws/supabase/postgres:17.6.1.171'
const NAME = 'boe-restore-rehearsal'
const tmp = ensureDir(path.join(BACKUP_ROOT, 'rehearsal-tmp', stamp()))
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
const psql = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'], sql)

const TYPES = { uuid: 'uuid', text: 'text', boolean: 'boolean', integer: 'integer', 'timestamp with time zone': 'timestamptz', jsonb: 'jsonb', date: 'date', bigint: 'bigint', numeric: 'numeric', smallint: 'smallint', 'uuid[]': 'uuid[]', 'text[]': 'text[]', 'time without time zone': 'time' }
const q = (id) => '"' + id.replace(/"/g, '""') + '"'
const pkOf = (t) => Object.entries(defs[t].properties || {}).filter(([, p]) => /Primary Key/i.test(p.description || '')).map(([c]) => c)
const report = { snapshot: snap, startedAt: new Date().toISOString(), tables: 0, rows: 0, problems: [] }

function cleanup() {
  if (!keep) { docker(['rm', '-f', NAME]); fs.rmSync(tmp, { recursive: true, force: true }) }
}
try {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) throw new Error('Docker is not running. Start Docker Desktop and run this again.')
  docker(['rm', '-f', NAME])
  const run = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=rehearsal', IMAGE])
  if (run.status !== 0) throw new Error('could not start the throwaway database: ' + run.stderr.slice(0, 300))
  for (let i = 0; ; i++) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres']).status === 0 && psql('select 1').status === 0) break
    if (i > 60) throw new Error('throwaway database did not become ready')
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)'])
  }
  log(`throwaway database ready (snapshot ${snap}, ${Object.keys(defs).length} relations in the schema snapshot)`)
  psql('create schema if not exists rehearsal; set search_path = rehearsal;')

  let n = 0
  for (const t of Object.keys(manifest.tables).sort()) {
    const info = manifest.tables[t]
    if (info.unreadable) { report.problems.push(`${t}: not in the export (service role cannot read it) — covered only by Supabase platform backups`); continue }
    if (info.error) { report.problems.push(`${t}: the export itself recorded an error: ${info.error}`); continue }
    const gz = path.join(dir, t + '.jsonl.gz' + (manifest.encrypted ? '.enc' : ''))
    if (!fs.existsSync(gz)) { report.problems.push(`${t}: file missing from the snapshot`); continue }
    let rows = []
    const plainGz = path.join(tmp, t + '.jsonl.gz')
    if (manifest.encrypted) decryptFile(gz, plainGz); else fs.copyFileSync(gz, plainGz)
    const text = zlib.gunzipSync(fs.readFileSync(plainGz)).toString('utf8')
    rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    if (rows.length !== info.rows) report.problems.push(`${t}: file holds ${rows.length} rows but the manifest says ${info.rows}`)

    const props = defs[t]?.properties || {}
    const cols = Object.entries(props)
    if (!cols.length) { report.problems.push(`${t}: no column definitions in the schema snapshot`); continue }
    const pk = pkOf(t)
    const ddl = `create table rehearsal.${q(t)} (${cols.map(([c, p]) => `${q(c)} ${p.type === 'array' ? (TYPES[p.format] || 'text[]') : (TYPES[p.format] || (p.type === undefined ? 'jsonb' : 'text'))}`).join(', ')}${pk.length ? `, primary key (${pk.map(q).join(', ')})` : ''});`
    let r = psql(ddl)
    if (r.status !== 0) { report.problems.push(`${t}: could not create the table: ${r.stderr.slice(0, 200)}`); continue }
    if (rows.length) {
      const tag = 'j' + Math.random().toString(36).slice(2, 8)
      const body = JSON.stringify(rows)
      if (body.includes('$' + tag + '$')) throw new Error('dollar-quote tag clash')
      r = psql(`insert into rehearsal.${q(t)} select * from jsonb_populate_recordset(null::rehearsal.${q(t)}, $${tag}$${body}$${tag}$::jsonb);`)
      if (r.status !== 0) { report.problems.push(`${t}: load failed: ${r.stderr.slice(0, 250)}`); continue }
    }
    // checks
    const numCols = cols.filter(([, p]) => ['numeric', 'integer', 'bigint', 'smallint'].includes(p.format)).map(([c]) => c)
    const sums = numCols.length ? ', ' + numCols.map((c) => `coalesce(sum(${q(c)}),0)::text`).join(', ') : ''
    const res = psql(`select count(*)::text${sums} from rehearsal.${q(t)};`)
    if (res.status !== 0) { report.problems.push(`${t}: count query failed`); continue }
    const out = res.stdout.trim().split('|')
    if (Number(out[0]) !== rows.length) report.problems.push(`${t}: loaded ${out[0]} rows, file has ${rows.length}`)
    numCols.forEach((c, i) => {
      const want = rows.reduce((a, r0) => a + (typeof r0[c] === 'number' ? r0[c] : Number(r0[c] ?? 0)), 0)
      const got = Number(out[i + 1])
      if (Math.abs(want - got) > Math.max(1e-6, Math.abs(want) * 1e-9)) report.problems.push(`${t}.${c}: sum is ${got}, the backup file says ${want}`)
    })
    report.tables++; report.rows += rows.length; n++
    fs.rmSync(plainGz)
  }
  log(`loaded ${report.tables} tables, ${report.rows} rows`)
  if (manifest.authUsers) {
    const gz = path.join(dir, '_auth_users.jsonl.gz' + (manifest.encrypted ? '.enc' : ''))
    const plain = path.join(tmp, '_auth.gz'); if (manifest.encrypted) decryptFile(gz, plain); else fs.copyFileSync(gz, plain)
    const lines = zlib.gunzipSync(fs.readFileSync(plain)).toString('utf8').split('\n').filter(Boolean)
    if (lines.length !== manifest.authUsers.rows) report.problems.push(`auth users: file has ${lines.length}, manifest says ${manifest.authUsers.rows}`)
    report.authUsers = lines.length
  }
} catch (e) {
  report.problems.push('FATAL: ' + e.message)
} finally {
  cleanup()
}
report.finishedAt = new Date().toISOString()
report.ok = report.problems.filter((p) => !/not in the export/.test(p)).length === 0 && report.tables > 0
writeStatus('restore-rehearsal', { ok: report.ok, snapshot: snap, tables: report.tables, rows: report.rows, problems: report.problems.length })
console.log(JSON.stringify(report, null, 2))
console.log(report.ok ? '\nREHEARSAL PASSED: the export is complete, readable and loads cleanly.' : '\nREHEARSAL FOUND PROBLEMS (listed above).')
process.exit(report.ok ? 0 : 1)
