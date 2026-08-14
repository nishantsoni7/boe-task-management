/**
 * Function-signature audit for the Access Control checkpoint migrations.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The first production attempt at 20260901000000 aborted at statement 18:
 *
 *   ERROR: function public.link_finance_payment_to_order(uuid, uuid, text)
 *          does not exist (SQLSTATE 42883)
 *
 * GRANT/REVOKE/COMMENT/DROP/ALTER resolve a function by its EXACT argument-type
 * list. A wrong list does not fall back to the real function — it raises 42883
 * and rolls the migration back, mid-deployment, against production. Nothing in
 * the repository caught it, because no test read the signatures.
 *
 * A second, quieter mismatch was found in the same sweep:
 * admin_delete_order_request was granted as (uuid) when it has always been
 * (uuid, boolean). It would have failed the very next statement.
 *
 * WHAT IT ASSERTS
 * ---------------
 * For every signature-bearing statement in 901 and 902, the argument-type list
 * must equal the list of the function's AUTHORITATIVE definition — parsed out of
 * whichever migration actually defines it. The expected values are DERIVED, not
 * hardcoded: correcting a typo by editing this file would not make a broken
 * migration pass, because the comparison target is the defining migration.
 *
 * Repository files only. No database.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/migrationSignatures.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')

const ENFORCEMENT = '20260901000000_finance_orders_permission_enforcement.sql'
const COMPATIBILITY = '20260902000000_access_control_v1_compatibility.sql'

const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8').replace(/\r\n/g, '\n')

/** Strip `--` line comments so commented-out SQL is never audited. */
const code = (sql: string) =>
  sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

// ── signature parsing ────────────────────────────────────────────────────────

/** Text inside the parentheses that open at `from`, respecting nesting. */
function balanced(src: string, openIdx: number): string | null {
  if (src[openIdx] !== '(') return null
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return null
}

/** Split on commas that sit at paren-depth 0. */
function topLevelSplit(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const c of s) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = '' } else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

/**
 * A DEFINITION's parameter list -> argument types.
 * `p_payment_request_ids uuid[] default '{}'::uuid[]` -> `uuid[]`
 */
function typesFromDefinition(paramText: string): string[] {
  if (!paramText.trim()) return []
  return topLevelSplit(paramText).map(raw => {
    let p = raw.trim().replace(/\s+/g, ' ')
    p = p.replace(/\s+default\s+.*$/i, '')          // drop the default
    p = p.replace(/^(in|out|inout|variadic)\s+/i, '') // drop the mode
    const parts = p.split(' ')
    return parts.slice(1).join(' ').toLowerCase().trim() || parts[0].toLowerCase()
  }).filter(Boolean)
}

/** A REFERENCE's argument list -> argument types (already just types). */
function typesFromReference(argText: string): string[] {
  if (!argText.trim()) return []
  return topLevelSplit(argText).map(a => a.trim().replace(/\s+/g, ' ').toLowerCase())
}

// ── build the authoritative definition index ─────────────────────────────────

type Def = { file: string; types: string[] }
/** name -> definitions, in migration order (last entry is authoritative). */
const definitions = new Map<string, Def[]>()

const DEF_RE = /create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(/gi

for (const f of files) {
  const src = code(read(f))
  for (const m of src.matchAll(DEF_RE)) {
    const name = m[1].toLowerCase()
    const open = m.index! + m[0].length - 1
    const inner = balanced(src, open)
    if (inner === null) continue
    const list = definitions.get(name) ?? []
    list.push({ file: f, types: typesFromDefinition(inner) })
    definitions.set(name, list)
  }
}

/**
 * The signature a reference in `inFile` must match: the definition in the SAME
 * migration if it has one (that is the version being installed), otherwise the
 * latest definition at or before it.
 */
function authoritative(name: string, inFile: string): Def | null {
  const defs = definitions.get(name)
  if (!defs?.length) return null
  const same = defs.filter(d => d.file === inFile)
  if (same.length) return same[same.length - 1]
  const prior = defs.filter(d => d.file <= inFile)
  return prior.length ? prior[prior.length - 1] : null
}

// ── collect signature-bearing references ─────────────────────────────────────

type Ref = { kind: string; name: string; types: string[]; file: string }

const REF_RES: Array<[string, RegExp]> = [
  ['grant',   /grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+)\s*\(/gi],
  ['revoke',  /revoke\s+[^;]*?\bon\s+function\s+public\.([a-z0-9_]+)\s*\(/gi],
  ['comment', /comment\s+on\s+function\s+public\.([a-z0-9_]+)\s*\(/gi],
  ['drop',    /drop\s+function\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)\s*\(/gi],
  ['alter',   /alter\s+function\s+public\.([a-z0-9_]+)\s*\(/gi],
]

function referencesIn(file: string): Ref[] {
  const src = code(read(file))
  const out: Ref[] = []
  for (const [kind, re] of REF_RES) {
    for (const m of src.matchAll(re)) {
      const open = m.index! + m[0].length - 1
      const inner = balanced(src, open)
      if (inner === null) continue
      out.push({ kind, name: m[1].toLowerCase(), types: typesFromReference(inner), file })
    }
  }
  return out
}

const fmt = (n: string, t: string[]) => `public.${n}(${t.join(', ')})`

// ── the audit ────────────────────────────────────────────────────────────────

describe('the parser reads real signatures', () => {
  test('definition parsing strips names, defaults and modes', () => {
    assert.deepEqual(typesFromDefinition('p_request_id uuid, p_admin_note text default null'),
      ['uuid', 'text'])
    assert.deepEqual(typesFromDefinition("p_a uuid, p_ids uuid[] default '{}'::uuid[]"),
      ['uuid', 'uuid[]'])
    assert.deepEqual(typesFromDefinition(''), [])
  })

  test('it indexed the migrations it is meant to audit', () => {
    // Guards against a regex that silently matches nothing.
    assert.ok(definitions.size > 20, `only ${definitions.size} functions indexed`)
    assert.ok(definitions.has('link_finance_payment_to_order'))
    assert.ok(definitions.has('admin_delete_order_request'))
  })
})

describe('20260901000000 — every function reference resolves', () => {
  const refs = referencesIn(ENFORCEMENT)

  test('the migration actually contains signature-bearing statements', () => {
    assert.ok(refs.length >= 6, `found only ${refs.length} references`)
  })

  for (const ref of refs) {
    test(`${ref.kind} ${fmt(ref.name, ref.types)}`, () => {
      const def = authoritative(ref.name, ref.file)
      assert.ok(def, `no definition of public.${ref.name} anywhere in supabase/migrations`)
      assert.deepEqual(
        ref.types, def.types,
        `${ref.kind} uses ${fmt(ref.name, ref.types)} but ${def.file} defines ` +
        `${fmt(ref.name, def.types)} — GRANT/REVOKE resolve by exact signature, ` +
        `so this raises 42883 at deploy time`,
      )
    })
  }
})

describe('20260902000000 — every function reference resolves', () => {
  const refs = referencesIn(COMPATIBILITY)

  for (const ref of refs) {
    test(`${ref.kind} ${fmt(ref.name, ref.types)}`, () => {
      const def = authoritative(ref.name, ref.file)
      assert.ok(def, `no definition of public.${ref.name} anywhere in supabase/migrations`)
      assert.deepEqual(ref.types, def.types)
    })
  }

  test('it introduces no execute grant of its own', () => {
    // 902 only moves permission ROWS. If it ever starts granting EXECUTE, that
    // is a scope change that must be reviewed, not absorbed silently.
    assert.equal(refs.filter(r => r.kind === 'grant').length, 0)
  })
})

describe('the two defects that broke the first deployment stay fixed', () => {
  // Named explicitly, but still compared against the DERIVED authoritative
  // signature — editing this file cannot make a broken migration pass.
  const enforcement = code(read(ENFORCEMENT))

  for (const name of ['link_finance_payment_to_order', 'admin_delete_order_request']) {
    test(`${name} is granted with its defining signature`, () => {
      const def = authoritative(name, ENFORCEMENT)
      assert.ok(def)
      const granted = referencesIn(ENFORCEMENT)
        .filter(r => r.kind === 'grant' && r.name === name)
      assert.equal(granted.length, 1, `expected exactly one grant for ${name}`)
      assert.deepEqual(granted[0].types, def.types)
    })
  }

  test('the exact failing statement is gone', () => {
    assert.equal(
      enforcement.includes('link_finance_payment_to_order(uuid, uuid, text)'),
      false,
      'the three-argument form never existed and must not reappear',
    )
  })
})

describe('no reference names a function the repository never defines', () => {
  test('901 and 902 reference only known functions', () => {
    const unknown: string[] = []
    for (const file of [ENFORCEMENT, COMPATIBILITY]) {
      for (const ref of referencesIn(file)) {
        if (!definitions.has(ref.name)) unknown.push(`${file}: ${ref.name}`)
      }
    }
    assert.deepEqual(unknown, [])
  })
})
