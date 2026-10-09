/**
 * `npm test` must not be able to open a Supabase connection.
 *
 * Why a contract and not a convention
 * -----------------------------------
 * Finding the live-database suites by hand was tried twice in one session and
 * was wrong both times. Grepping for `createClient(` reported nine files: six
 * were false positives — suites that read a route's SOURCE and assert it
 * contains `await createClient()`, which never connects to anything — and it
 * missed five others. A second pass by import found three genuine offenders
 * the first pass had also mixed in with the noise.
 *
 * That is the real lesson of the incident behind this directory: 22 fixture
 * accounts reached production because nobody could tell, by looking, which
 * tests talked to a database. So this asserts it instead.
 *
 * The rule
 * --------
 * A file loaded by the default `npm test` globs may not VALUE-import the
 * Supabase client factory. `import type { SupabaseClient }` stays legal — a
 * type is erased at compile time and cannot connect to anything, and it is
 * how the genuinely-mocked suites take a stub client as a parameter.
 *
 * Live-DB suites live behind `.livedb-test.ts`, which the default globs do
 * not match, and go through resolveLiveDbTestEnv() — see
 * liveDbTestDiscovery.test.ts for that half of the arrangement.
 *
 * Why scrub first
 * ---------------
 * Source-assertion suites contain import statements inside string literals.
 * Matching raw text would flag them, so comments and string/template literals
 * are removed before any import is read. The detector is self-tested below,
 * so a scrubber that quietly stops working fails this file rather than
 * silently passing everything.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { valueImportedModules } from '@/lib/security/testSourceScan'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Anything that can hand back a real, connected client. */
const CONNECTING_MODULES = [
  '@supabase/supabase-js',
  '@supabase/ssr',
  '@/lib/supabase/admin',
  '@/lib/supabase/adminClient',
  '@/lib/supabase/client',
  '@/lib/supabase/server',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const rel = (absolute: string) => relative(ROOT, absolute).split(sep).join('/')

/** Exactly what the `test` script's globs load. */
const defaultRunFiles = [
  ...walk(join(ROOT, 'src')).map(rel).filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx')),
  ...walk(join(ROOT, 'scripts')).map(rel).filter(f => f.endsWith('.test.mjs')),
]

describe('the detector itself works', () => {
  test('a real value import is detected', () => {
    const source = `import { createClient } from '@supabase/supabase-js'\n`
    assert.deepEqual(valueImportedModules(source), ['@supabase/supabase-js'])
  })

  test('a type-only import is not a connection', () => {
    const source = `import type { SupabaseClient } from '@supabase/supabase-js'\n`
    assert.deepEqual(valueImportedModules(source), [])
  })

  test('inline type modifiers are not a connection', () => {
    const source = `import { type SupabaseClient } from '@supabase/supabase-js'\n`
    assert.deepEqual(valueImportedModules(source), [])
  })

  test('an import quoted inside an assertion string is not a connection', () => {
    // The exact false positive that made two manual sweeps wrong.
    const source = [
      `import assert from 'node:assert/strict'`,
      `const route = readFileSync(p, 'utf8')`,
      "assert.ok(route.includes(\"import { createClient } from '@supabase/supabase-js'\"))",
      'assert.ok(route.includes("const caller = await createClient()"))',
    ].join('\n')
    assert.deepEqual(valueImportedModules(source), ['node:assert/strict'])
  })

  test('comments do not count', () => {
    const source = `// import { createClient } from '@supabase/supabase-js'\nconst a = 1\n`
    assert.deepEqual(valueImportedModules(source), [])
  })
})

describe('no test in the default run can construct a Supabase client', () => {
  test('the default globs load at least the bulk of the suite', () => {
    // Guards against the walk silently returning nothing and this file
    // "passing" because it inspected zero sources.
    assert.ok(defaultRunFiles.length > 300, `only found ${defaultRunFiles.length} default-run test files`)
  })

  test('none of them value-imports a client factory', () => {
    const offenders: string[] = []
    for (const file of defaultRunFiles) {
      const imported = valueImportedModules(readFileSync(join(ROOT, file), 'utf8'))
      const bad = imported.filter(m => CONNECTING_MODULES.includes(m))
      if (bad.length > 0) offenders.push(`${file} -> ${bad.join(', ')}`)
    }
    assert.deepEqual(
      offenders,
      [],
      'these run inside npm test and can open a real Supabase connection. Rename them to ' +
        '*.livedb-test.ts and resolve their environment through resolveLiveDbTestEnv(), or take ' +
        'the client as a parameter with an `import type` and pass a stub:\n' +
        offenders.join('\n'),
    )
  })
})
