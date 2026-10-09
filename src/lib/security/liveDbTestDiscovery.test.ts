/**
 * The boundary between the deterministic test run and the live-database one.
 *
 * Eight suites talk to a real Supabase database — four proving RLS with
 * genuine authenticated sessions, and three payroll route suites that create
 * and delete real payroll periods. They cannot run as part of
 * ordinary `npm test`: the standard `.env.local` points at production, so the
 * environment guard refuses the target and calls `process.exit(1)`. Under
 * `tsx --test` each file is its own process, so that refusal is reported as a
 * FAILING test file — not a skipped one. Ordinary `npm test` was red for
 * anyone with the standard local configuration.
 *
 * The fix is discovery, not skipping. Those files carry a `.livedb-test.ts`
 * suffix, which the default `src/**\/*.test.ts` glob does not match — the
 * character before `test.ts` is a hyphen, not a dot — so `npm test` never
 * loads them, and `npm run test:live-db` selects exactly them. Nothing is
 * marked skipped, and the clean-main rule (0 failures, 0 skipped) holds
 * without weakening the guard.
 *
 * This file pins that arrangement. It is a plain unit test: it reads the
 * repository, never the database.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { callsFunction } from '@/lib/security/testSourceScan'

/** Repo root: this file sits at <root>/src/lib/security. */
const ROOT = join(import.meta.dirname, '..', '..', '..')

const LIVE_DB_SUFFIX = '.livedb-test.ts'

/**
 * Every live-DB suite, by repo-relative path with forward slashes.
 *
 * Listed literally rather than discovered, so that adding a live-DB suite
 * without deciding where it runs fails this test instead of passing quietly.
 */
const EXPECTED_LIVE_DB_SUITES = [
  'src/app/api/payroll/delete/route.livedb-test.ts',
  'src/app/api/payroll/periods/route.livedb-test.ts',
  'src/app/api/payroll/settlementAuth.livedb-test.ts',
  'src/app/api/payroll/unlock/route.livedb-test.ts',
  'src/lib/security/attendancePayrollApiIsolation.livedb-test.ts',
  'src/lib/security/attendancePayrollIsolation.livedb-test.ts',
  'src/lib/security/objectionIsolation.livedb-test.ts',
  'src/lib/security/usersPrivateColumns.livedb-test.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const repoRelative = (absolute: string) => relative(ROOT, absolute).split('\\').join('/')

const sourceFiles = walk(join(ROOT, 'src')).map(repoRelative)

const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as
  Record<string, string>

describe('live-DB suites are separated from the default test run', () => {
  test('exactly the known suites carry the live-DB suffix', () => {
    const found = sourceFiles.filter(f => f.endsWith(LIVE_DB_SUFFIX)).sort()
    assert.deepEqual(found, EXPECTED_LIVE_DB_SUITES)
  })

  test('no live-DB suite is named so the default glob would load it', () => {
    // `src/**/*.test.ts` matches only a literal `.test.ts` ending. A file
    // named `x.livedb-test.ts` ends in `-test.ts`, so it is not matched.
    for (const file of sourceFiles.filter(f => f.endsWith(LIVE_DB_SUFFIX))) {
      assert.equal(file.endsWith('.test.ts'), false, `${file} would be loaded by npm test`)
    }
  })

  test('every live-DB suite actually goes through the environment guard', () => {
    for (const file of EXPECTED_LIVE_DB_SUITES) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      assert.ok(
        source.includes('resolveLiveDbTestEnv'),
        `${file} creates live fixtures but does not call resolveLiveDbTestEnv`,
      )
    }
  })

  test('the default test script does not reach the live-DB suffix', () => {
    assert.ok(scripts.test.includes('src/**/*.test.ts'))
    assert.equal(scripts.test.includes(LIVE_DB_SUFFIX), false)
  })

  test('a dedicated script selects the live-DB suites', () => {
    assert.ok(scripts['test:live-db'], 'package.json needs a test:live-db script')
    assert.ok(scripts['test:live-db'].includes(`src/**/*${LIVE_DB_SUFFIX}`))
  })

  test('no live-DB suite sits in the guarded set without being listed here', () => {
    // A suite that calls the guard but still ends in `.test.ts` would run
    // inside npm test and fail on the production refusal — the exact defect
    // this separation exists to prevent. The two helper unit tests import the
    // guard to test it with an injected environment, so they are excluded by
    // requiring an actual resolveLiveDbTestEnv() call site.
    // callsFunction scrubs comments and string literals first, so a file that
    // merely names the guard in prose is not mistaken for one that invokes it.
    const guarded = sourceFiles.filter(
      file =>
        file.endsWith('.test.ts') &&
        callsFunction(readFileSync(join(ROOT, file), 'utf8'), 'resolveLiveDbTestEnv'),
    )
    assert.deepEqual(guarded, [], `these run in npm test but call the live-DB guard: ${guarded}`)
  })
})
