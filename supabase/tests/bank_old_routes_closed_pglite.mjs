// Proves 20270516000100 on a real Postgres (PGlite): who can still call what, that
// the migration can be run twice, and that its own assertions stop a bad apply. The
// functions are stubs with the real signatures: this migration only changes grants.
//
// Usage: node supabase/tests/bank_old_routes_closed_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all 6 checks passed".
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const env = process.argv[2]
if (!env) { console.error('usage: node bank_old_routes_closed_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const { PGlite } = await import(pathToFileURL(join(env, 'node_modules/@electric-sql/pglite/dist/index.js')).href)

const here = dirname(fileURLToPath(import.meta.url))
const migration = readFileSync(process.env.BANK_ROUTES_MIGRATION ?? join(here, '../migrations/20270516000100_finance_bank_old_routes_closed.sql'), 'utf8')

const SIGNATURES = [
  'sync_bank_credits(p uuid[])',
  'add_bank_line_to_confirmed(a uuid, b uuid[], c text)',
  'create_payment_from_bank_line(a uuid, b boolean, c text)',
  'verify_payment_with_bank(a uuid, b uuid[])',
]
const DIRECT = ['sync_bank_credits(uuid[])', 'add_bank_line_to_confirmed(uuid, uuid[], text)', 'verify_payment_with_bank(uuid, uuid[])']

async function fresh() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated;`)
  for (const s of SIGNATURES) {
    await db.exec(`create function public.${s} returns jsonb language sql as $$ select '{}'::jsonb $$;
      revoke all on function public.${s.replace(/\b[abp] /g, '')} from public, anon;`)
  }
  for (const f of DIRECT) await db.exec(`grant execute on function public.${f} to authenticated;`)
  return db
}
const can = async (db, role, f) =>
  (await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, `public.${f}`])).rows[0].ok

let n = 0
const check = async (name, fn) => { await fn(); console.log(`ok ${++n} ${name}`) }

const db = await fresh()
await check('before it, both old doors are open', async () => {
  assert.equal(await can(db, 'authenticated', 'sync_bank_credits(uuid[])'), true)
  assert.equal(await can(db, 'authenticated', 'add_bank_line_to_confirmed(uuid, uuid[], text)'), true)
})

await db.exec(migration)

await check('after it, neither old door opens to a signed-in browser or to anon', async () => {
  for (const f of ['sync_bank_credits(uuid[])', 'add_bank_line_to_confirmed(uuid, uuid[], text)']) {
    assert.equal(await can(db, 'authenticated', f), false, f)
    assert.equal(await can(db, 'anon', f), false, f)
  }
})

await check('a signed-in browser is really refused', async () => {
  await db.exec('set role authenticated')
  await assert.rejects(db.query(`select public.sync_bank_credits('{}'::uuid[])`), /permission denied/)
  await db.exec('reset role')
})

await check('verifying stays open', async () => {
  assert.equal(await can(db, 'authenticated', 'verify_payment_with_bank(uuid, uuid[])'), true)
})

await check('the migration can be run twice', async () => { await db.exec(migration) })

await check('it refuses to finish if the door that replaced them is closed', async () => {
  const bad = await fresh()
  await bad.exec(`revoke all on function public.verify_payment_with_bank(uuid, uuid[]) from authenticated`)
  await assert.rejects(bad.exec(migration), /must stay callable/)
})

assert.equal(n, 6)
console.log(`all ${n} checks passed`)
