/**
 * Every test file this repository contains is actually RUN by the standard
 * command.
 *
 * THE DEFECT THIS EXISTS TO PREVENT RECURRING
 * -------------------------------------------
 * `src/app/orders/drafts/[submissionId]/piDetail.render.test.tsx` was invisible
 * to the suite for its entire life. Node's test runner treats a path argument as
 * a GLOB, so the literal `[submissionId]` in the path is read as a character
 * class — it matches `s`, `u`, `b`… and therefore matches no directory that
 * exists. `node --test <that path>` reported, cheerfully:
 *
 *     # tests 0
 *     # pass 0
 *     # fail 0
 *
 * and a shell loop that passed every discovered file as an argument reported
 * 5,793 tests where the repository actually holds 5,939. A hundred and forty-six
 * assertions about who may approve a PI, what a blocked approval says, and which
 * RPCs the record page may call were never checked by anything.
 *
 * A test that is skipped silently is worse than a test that does not exist: the
 * count goes up, the report is green, and nobody looks.
 *
 * WHAT THIS FILE ASSERTS
 * ----------------------
 * That the `test` script in package.json, expanded as globs, reaches EVERY
 * `*.test.*` file under `src` and `scripts`. It uses the real glob engine
 * (`node:fs`) against the real filesystem, so it cannot pass by agreeing with a
 * comment.
 *
 * Run:
 *   npm test
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { globSync } = require('node:fs') as { globSync: (p: string, o: { cwd: string }) => string[] }
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

/** Every test file that exists, as repo-relative POSIX paths. */
function everyTestFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      everyTestFile(path, out)
    } else if (/\.test\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

/** The glob arguments the `test` script passes to the runner. */
function testScriptGlobs(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = pkg.scripts?.test
  assert.ok(script, 'package.json must define a `test` script')
  // Double-quoted arguments, which is what keeps the globs intact on both a
  // POSIX shell and cmd.exe — the repository is developed on Windows.
  return [...script.matchAll(/"([^"]+)"/g)].map(m => m[1])
}

const declared = everyTestFile('src').concat(everyTestFile('scripts')).sort()

const reached = new Set(
  testScriptGlobs()
    .flatMap(pattern => globSync(pattern, { cwd: ROOT }))
    .map(p => relative(ROOT, join(ROOT, p)).split(sep).join('/')),
)

describe('the standard test command reaches every test file', () => {
  test('the repository has test files to reach at all', () => {
    // Guards against a walker that silently found nothing and then "passed".
    assert.ok(declared.length > 100, `only ${declared.length} test files found`)
  })

  test('the `test` script is glob-based, and its globs are quoted', () => {
    const globs = testScriptGlobs()
    assert.ok(globs.length >= 2, 'at least the .ts and .tsx trees must be named')
    for (const pattern of globs) {
      assert.ok(pattern.includes('**'),
        `"${pattern}" must recurse — a flat list drifts the moment a directory is added`)
    }
  })

  test('EVERY test file is matched, including ones under a [bracketed] route', () => {
    const missed = declared.filter(file => !reached.has(file))
    assert.deepEqual(missed, [],
      'these test files exist and the standard command would never run them')
  })

  test('the bracketed PI-detail suite specifically is reached', () => {
    // Named explicitly, because this is the one that was skipped and the one a
    // future Next.js dynamic route is most likely to reproduce.
    const bracketed = 'src/app/orders/drafts/[submissionId]/piDetail.render.test.tsx'
    assert.ok(declared.includes(bracketed), 'the suite must still exist')
    assert.ok(reached.has(bracketed),
      'node treats [submissionId] as a character class; the glob must still match it')
  })

  test('nothing is reached that is not a test file', () => {
    for (const file of reached) {
      assert.match(file, /\.test\.(ts|tsx|mjs|js)$/, `${file} is not a test file`)
    }
  })
})
