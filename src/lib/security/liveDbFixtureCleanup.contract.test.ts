/**
 * Structural regression pins for the five live-DB test suites that create
 * real Supabase auth users, profiles and business rows: objectionIsolation,
 * attendancePayrollIsolation, attendancePayrollApiIsolation,
 * usersPrivateColumns and settlementAuth.
 *
 * These read source rather than hit a database on purpose — the point is to
 * pin the two concrete defects that let 22 `@example.invalid` fixtures leak
 * into production, plus the containment mechanism, so a future edit to any
 * of these files cannot silently reintroduce them:
 *
 *   1. Every suite must resolve its environment through the shared guard
 *      (resolveLiveDbTestEnv), not read NEXT_PUBLIC_SUPABASE_URL /
 *      SUPABASE_SERVICE_ROLE_KEY directly — that direct read is exactly how
 *      these suites ran against production with no check at all.
 *   2. Every suite's teardown must go through runCleanupSteps, so a blocked
 *      delete is surfaced instead of silently discarded.
 *   3. objectionIsolation's teardown must not be gated on `seeded` — that
 *      gate is what let a throw partway through before() skip cleanup
 *      entirely and orphan already-created actors.
 *   4. settlementAuth's teardown must delete payroll_settlements before
 *      payroll_results — the reverse order violates
 *      payroll_settlements.payroll_result_id's foreign key.
 *   5. Every delete inside a teardown must be scoped by `.eq(` or `.in(` —
 *      never an unfiltered table-wide delete that could reach a legitimate,
 *      non-fixture row.
 *
 * Run:
 *   npx tsx --test src/lib/security/liveDbFixtureCleanup.contract.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const SUITES = [
  'src/lib/security/objectionIsolation.test.ts',
  'src/lib/security/attendancePayrollIsolation.test.ts',
  'src/lib/security/attendancePayrollApiIsolation.test.ts',
  'src/lib/security/usersPrivateColumns.test.ts',
  'src/app/api/payroll/settlementAuth.test.ts',
]

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

/** The teardown block: from the after() hook to its closing `})` at column 0. */
function extractAfterBlock(source: string): string {
  const start = source.indexOf('after(async () => {')
  assert.notEqual(start, -1, 'expected an after(async () => { ... }) teardown hook')
  const end = source.indexOf('\n})', start)
  assert.notEqual(end, -1, 'could not find the end of the after() teardown hook')
  return source.slice(start, end)
}

describe('every live-DB suite resolves its environment through the shared guard', () => {
  for (const suite of SUITES) {
    test(suite, () => {
      const source = read(suite)
      assert.match(
        source,
        /from ['"]@\/lib\/security\/liveDbTestSupport['"]/,
        'must import the shared guard/cleanup module',
      )
      assert.match(
        source,
        /resolveLiveDbTestEnv\(\)/,
        'must resolve its Supabase env through the target guard, not read process.env directly',
      )
      // The old unguarded pattern this replaces — reading the URL/key
      // straight from process.env with no target check at all.
      assert.doesNotMatch(
        source,
        /process\.env\.NEXT_PUBLIC_SUPABASE_URL/,
        'must not read the Supabase URL directly, bypassing the target guard',
      )
      assert.doesNotMatch(
        source,
        /process\.env\.SUPABASE_SERVICE_ROLE_KEY/,
        'must not read the service-role key directly, bypassing the target guard',
      )
    })
  }
})

describe('every live-DB suite tears down through runCleanupSteps', () => {
  for (const suite of SUITES) {
    test(suite, () => {
      const source = read(suite)
      assert.match(source, /import\s*\{[^}]*runCleanupSteps[^}]*\}/, 'must import runCleanupSteps')
      const afterBlock = extractAfterBlock(source)
      assert.match(afterBlock, /runCleanupSteps\(/, 'the teardown hook must call runCleanupSteps')
    })
  }
})

describe('every delete inside a teardown is scoped to specific fixture ids', () => {
  for (const suite of SUITES) {
    test(suite, () => {
      const source = read(suite)
      const afterBlock = extractAfterBlock(source)
      const deleteCalls = afterBlock.match(/\.delete\(\)/g) ?? []
      assert.ok(deleteCalls.length > 0, 'expected at least one .delete() call in teardown')

      // Every .delete() must be immediately followed (allowing a line break,
      // as in the multi-line attendance_records call) by a .eq(/.in( filter —
      // never left bare, which would touch every row in the table.
      const bareDelete = /\.delete\(\)(?!\s*\n?\s*\.(eq|in)\()/
      assert.doesNotMatch(
        afterBlock,
        bareDelete,
        'a teardown .delete() must always be scoped by .eq(...) or .in(...) to this run\'s own fixture ids',
      )
    })
  }
})

describe('objectionIsolation cleanup is not gated on before() having fully succeeded', () => {
  test('src/lib/security/objectionIsolation.test.ts', () => {
    const source = read('src/lib/security/objectionIsolation.test.ts')
    const afterBlock = extractAfterBlock(source)
    assert.doesNotMatch(
      afterBlock,
      /if\s*\(\s*!seeded\s*\)\s*return/,
      'teardown must run for whatever was actually created, not skip entirely when before() threw partway through',
    )
    // `seeded` still has a legitimate use elsewhere in the file (gating the
    // second, nested before() that files an extra objection) — this only
    // pins that cleanup itself no longer depends on it.
    assert.match(source, /\bseeded\b/, 'the seeded flag itself should still exist for its other use')
  })
})

describe('settlementAuth deletes payroll_settlements before payroll_results', () => {
  test('src/app/api/payroll/settlementAuth.test.ts', () => {
    const source = read('src/app/api/payroll/settlementAuth.test.ts')
    const afterBlock = extractAfterBlock(source)

    const settlementsIndex = afterBlock.indexOf(`svc.from('payroll_settlements').delete()`)
    const resultsIndex = afterBlock.indexOf(`svc.from('payroll_results').delete()`)

    assert.notEqual(settlementsIndex, -1, 'expected a payroll_settlements delete step')
    assert.notEqual(resultsIndex, -1, 'expected a payroll_results delete step')
    assert.ok(
      settlementsIndex < resultsIndex,
      'payroll_settlements.payroll_result_id has no ON DELETE clause, so settlements must be deleted ' +
        'before the payroll_results row they reference, or the results delete fails on a foreign-key violation',
    )
  })
})
