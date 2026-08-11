/**
 * The UAT scripts must not carry credentials.
 *
 * WHAT THIS IS FOR
 * ----------------
 * scripts/uat-seed.mjs, uat-cleanup.mjs and uat-simulate.mjs each held a
 * Supabase `service_role` JWT for the PRODUCTION project, in tracked source,
 * from the first week of the project. A service_role key bypasses every
 * row-level security policy, so that one literal defeated the entire
 * authorization model documented in docs/BOE Master Context/08_Authorization_Matrix.md.
 *
 * The credentials now come from the environment. This test is what stops them
 * coming back: it fails if a token-shaped literal, a project ref or a password
 * assignment reappears in any script, and it fails if a script stops requiring
 * its variables.
 *
 * It is deliberately a repository test rather than a lint rule — it is about
 * one specific class of mistake with one specific blast radius, and it should
 * read as a security assertion, not a style preference.
 *
 * NOTE: this proves the scripts no longer CARRY the secret. It says nothing
 * about the copy in Git history, which only rotation at Supabase revokes.
 *
 * Run:
 *   npx tsx --test src/lib/security/uatScriptCredentials.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const UAT_SCRIPTS = [
  'scripts/uat-seed.mjs',
  'scripts/uat-cleanup.mjs',
  'scripts/uat-simulate.mjs',
]

/** A JWT: header.payload.signature in base64url. The shape of a Supabase key. */
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/

describe('UAT scripts carry no credentials', () => {
  for (const path of UAT_SCRIPTS) {
    test(`${path} contains no token literal`, () => {
      assert.equal(JWT.test(read(path)), false,
        `${path} contains a JWT-shaped literal — credentials belong in the environment`)
    })

    test(`${path} names no Supabase project`, () => {
      // A project ref is not itself a secret, but hard-coding one is how a
      // script aimed at a scratch project silently runs against production.
      assert.equal(/[a-z]{20}\.supabase\.co/.test(read(path)), false,
        `${path} hard-codes a Supabase project URL`)
    })

    test(`${path} assigns no literal password`, () => {
      const src = read(path)
      const bad = /\b(?:UAT_PASSWORD|password|secret)\s*=\s*['"`][^'"`\n]{6,}['"`]/i.exec(src)
      assert.equal(bad, null, `${path} assigns a literal credential: ${bad?.[0].slice(0, 24)}…`)
    })

    test(`${path} requires its environment before doing anything`, () => {
      const src = read(path)
      assert.match(src, /requireUatEnv\(/, `${path} does not call requireUatEnv`)
      // The guard must run before a client is constructed, or a missing
      // variable becomes an obscure Supabase error instead of a clear one.
      assert.ok(
        src.indexOf('requireUatEnv(') < src.indexOf('createClient('),
        `${path} builds a client before checking its environment`,
      )
    })
  }
})

describe('the shared environment guard', () => {
  const envModule = read('scripts/uat-env.mjs')

  test('every variable is required — there are no defaults or fallbacks', () => {
    // `process.env.X || 'something'` is the failure mode: it turns a missing
    // variable into a silent wrong target rather than a stop.
    assert.equal(/process\.env\[[^\]]+\]\s*(\|\||\?\?)/.test(envModule), false,
      'a fallback would let a script run against an unintended project')
    assert.match(envModule, /process\.exit\(1\)/, 'a missing variable must stop the script')
  })

  test('it never logs a secret value', () => {
    // The URL is printed on purpose — it is not a secret and it is the only way
    // an operator can confirm the target. Nothing else may be.
    const logged = [...envModule.matchAll(/console\.(log|error)\(([^\n]*)/g)].map(m => m[2])
    for (const line of logged) {
      assert.equal(/SERVICE_ROLE_KEY\]|ANON_KEY\]|UAT_PASSWORD\]/.test(line), false,
        `the guard logs a secret value: ${line.slice(0, 60)}`)
    }
    assert.match(envModule, /values\.UAT_SUPABASE_URL/, 'the target URL should be shown')
  })

  test('the declared variables are the ones the scripts use', () => {
    const declared = [...envModule.matchAll(/name:\s*'([A-Z_]+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(declared, [
      'UAT_PASSWORD',
      'UAT_SUPABASE_ANON_KEY',
      'UAT_SUPABASE_SERVICE_ROLE_KEY',
      'UAT_SUPABASE_URL',
    ])

    // Each script asks only for what it needs — uat-cleanup signs in as nobody.
    const cleanup = read('scripts/uat-cleanup.mjs')
    assert.equal(cleanup.includes('UAT_SUPABASE_ANON_KEY'), false,
      'cleanup does not sign in, so it must not demand an anon key')
    assert.equal(cleanup.includes('UAT_PASSWORD'), false,
      'cleanup does not sign in, so it must not demand a password')
  })
})

describe('the example file and ignore rules', () => {
  test('an example exists and holds no real values', () => {
    const example = 'scripts/uat.env.example'
    assert.ok(existsSync(join(ROOT, example)), `${example} is missing`)
    const src = read(example)
    assert.equal(JWT.test(src), false, 'the example contains a real token')
    assert.equal(/[a-z]{20}\.supabase\.co/.test(src), false, 'the example names a real project')
    for (const name of [
      'UAT_SUPABASE_URL', 'UAT_SUPABASE_SERVICE_ROLE_KEY',
      'UAT_SUPABASE_ANON_KEY', 'UAT_PASSWORD',
    ]) {
      assert.ok(src.includes(name), `the example omits ${name}`)
    }
  })

  test('filled-in environment files stay ignored, and the example does not', () => {
    const ignore = read('.gitignore')
    assert.match(ignore, /^\.env\*$/m, '.env* must be ignored')
    assert.match(ignore, /^!\.env\.example$/m, 'the example must be exempt from the ignore rule')
  })
})
