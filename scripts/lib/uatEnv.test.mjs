/**
 * Guard tests for the UAT scripts' shared environment resolution.
 *
 * Entirely offline: every case either throws before a client could exist, or
 * hands off to an injected fake `createClient`. `globalThis.fetch` is replaced
 * with a throwing stub for the whole file, so any accidental network call
 * fails the test rather than reaching a real project.
 *
 * The credential values used below are obvious fakes. Real ones must never
 * appear in this repo.
 *
 * Run:
 *   npx tsx --test scripts/lib/uatEnv.test.mjs
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  REMOTE_OVERRIDE_PHRASE,
  REMOTE_OVERRIDE_VAR,
  UatEnvError,
  assertTargetAllowed,
  createUatAdminClient,
  expectedOverrideFor,
  isLocalTarget,
  projectRefFromUrl,
  resolveUatEnv,
} from './uatEnv.mjs'

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const UAT_SCRIPTS = ['uat-seed.mjs', 'uat-simulate.mjs', 'uat-cleanup.mjs']

// Fake secrets. Distinctive enough that a leak into a message is unmistakable.
const FAKE_SERVICE_KEY = 'fake-service-role-key-SHOULD-NEVER-BE-LOGGED'
const FAKE_ANON_KEY = 'fake-anon-key-SHOULD-NEVER-BE-LOGGED'
const FAKE_PASSWORD = 'fake-password-SHOULD-NEVER-BE-LOGGED'
const LOCAL_URL = 'http://localhost:54321'

// Two hosted targets, both fabricated. Same shape as any real project.
const UAT_REF = 'exampleuatref000abcd'
const UAT_URL = `https://${UAT_REF}.supabase.co`
const OTHER_REF = 'exampleotherref111z'
const OTHER_URL = `https://${OTHER_REF}.supabase.co`

const GOOD_OVERRIDE = expectedOverrideFor(UAT_REF)

const SECRETS = [FAKE_SERVICE_KEY, FAKE_ANON_KEY, FAKE_PASSWORD]
const IDENTIFIERS = [UAT_REF, UAT_URL, OTHER_REF, OTHER_URL, LOCAL_URL]

function envFor(url, extra = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_ANON_KEY,
    UAT_USER_PASSWORD: FAKE_PASSWORD,
    ...extra,
  }
}

const localEnv = (extra = {}) => envFor(LOCAL_URL, extra)
const hostedEnv = (extra = {}) => envFor(UAT_URL, extra)

// Any network attempt is a test failure, not a slow test.
let realFetch
before(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('network call attempted during an offline test')
  }
})
after(() => {
  globalThis.fetch = realFetch
})

describe('missing variables fail before any network call', () => {
  for (const missing of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    test(`${missing} absent → throws`, () => {
      const env = localEnv()
      delete env[missing]
      assert.throws(() => resolveUatEnv({ env }), (error) => {
        assert.ok(error instanceof UatEnvError)
        assert.match(error.message, new RegExp(`Missing ${missing}`))
        return true
      })
    })

    test(`${missing} empty or blank → throws`, () => {
      assert.throws(() => resolveUatEnv({ env: localEnv({ [missing]: '   ' }) }), UatEnvError)
    })
  }

  test('anon key only required when the script asks for it', () => {
    const env = localEnv()
    delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    assert.doesNotThrow(() => resolveUatEnv({ env }))
    assert.throws(() => resolveUatEnv({ env, requireAnonKey: true }), UatEnvError)
  })

  test('user password only required when the script asks for it', () => {
    const env = localEnv()
    delete env.UAT_USER_PASSWORD
    assert.doesNotThrow(() => resolveUatEnv({ env }))
    assert.throws(() => resolveUatEnv({ env, requireUserPassword: true }), UatEnvError)
  })

  test('validation runs before the client factory is ever reached', () => {
    const env = localEnv()
    delete env.SUPABASE_SERVICE_ROLE_KEY
    let factoryCalls = 0
    const factory = () => {
      factoryCalls++
      return {}
    }
    assert.throws(() => {
      createUatAdminClient(resolveUatEnv({ env }), factory)
    }, UatEnvError)
    assert.equal(factoryCalls, 0)
  })
})

describe('project reference extraction fails closed', () => {
  test('reads the first host label of a hosted URL', () => {
    assert.equal(projectRefFromUrl(UAT_URL), UAT_REF)
    assert.equal(projectRefFromUrl(`${UAT_URL}/rest/v1`), UAT_REF)
    assert.equal(projectRefFromUrl(`https://${UAT_REF.toUpperCase()}.supabase.co`), UAT_REF)
  })

  for (const [label, url] of [
    ['unparseable', 'not-a-url'],
    ['empty', ''],
    ['no scheme', 'exampleuatref000abcd.supabase.co'],
    ['non-http scheme', 'postgresql://exampleuatref000abcd.supabase.co'],
    ['too few labels', 'https://supabase.co'],
    ['bare host', 'https://justahost'],
    ['leading hyphen label', 'https://-badref.supabase.co'],
    ['trailing hyphen label', 'https://badref-.supabase.co'],
    ['label too short', 'https://ab.supabase.co'],
    ['illegal characters', 'https://bad_ref!.supabase.co'],
  ]) {
    test(`${label} → null, never a guess`, () => {
      assert.equal(projectRefFromUrl(url), null)
    })

    test(`${label} → hosted target refused even with a correct-looking override`, () => {
      // No reference can be derived, so nothing can authorize it.
      assert.throws(
        () => assertTargetAllowed(url, `${REMOTE_OVERRIDE_PHRASE}:anything`),
        UatEnvError,
      )
    })
  }
})

describe('production-shaped target is blocked by default', () => {
  test('hosted project with no override → throws', () => {
    assert.throws(() => resolveUatEnv({ env: hostedEnv(), shellOverride: undefined }), UatEnvError)
  })

  test('refusal explains the block without naming the project', () => {
    let message = ''
    try {
      resolveUatEnv({ env: hostedEnv(), shellOverride: undefined })
    } catch (error) {
      message = error.message
    }
    assert.match(message, /Refusing to run/)
    assert.ok(!message.includes(UAT_REF), 'leaked the project reference')
    assert.doesNotMatch(message, /supabase\.co/)
  })

  test('local targets are recognised and need no override', () => {
    for (const url of [
      'http://localhost:54321',
      'http://127.0.0.1:54321',
      'http://[::1]:54321',
      'http://0.0.0.0:54321',
      'http://db.localhost:54321',
      'https://stack.localhost',
    ]) {
      assert.equal(isLocalTarget(url), true, url)
      assert.doesNotThrow(() => assertTargetAllowed(url, undefined), url)
    }
  })

  test('*.local is NOT treated as local — mDNS names are other machines', () => {
    for (const url of ['http://supabase.local', 'http://my-nas.local:54321']) {
      assert.equal(isLocalTarget(url), false, url)
      assert.throws(() => assertTargetAllowed(url, undefined), UatEnvError, url)
    }
  })

  test('a hosted host is not local, and an unparseable URL is not treated as local', () => {
    assert.equal(isLocalTarget(UAT_URL), false)
    assert.equal(isLocalTarget('not-a-url'), false)
    assert.throws(() => assertTargetAllowed('not-a-url', undefined), UatEnvError)
  })
})

describe('the override is bound to one exact project reference', () => {
  test('the override naming this project authorizes it', () => {
    assert.doesNotThrow(() => assertTargetAllowed(UAT_URL, GOOD_OVERRIDE))
  })

  test('an override naming a DIFFERENT project is rejected', () => {
    assert.throws(
      () => assertTargetAllowed(UAT_URL, expectedOverrideFor(OTHER_REF)),
      UatEnvError,
    )
  })

  test('a stale override stops working once the target URL changes', () => {
    // Same override value, same shell; only the configured URL moved.
    assert.doesNotThrow(() =>
      resolveUatEnv({ env: envFor(UAT_URL), shellOverride: GOOD_OVERRIDE }),
    )
    assert.throws(
      () => resolveUatEnv({ env: envFor(OTHER_URL), shellOverride: GOOD_OVERRIDE }),
      UatEnvError,
    )
  })

  const wrongValues = [
    ['the bare phrase with no reference', REMOTE_OVERRIDE_PHRASE],
    ['phrase with a trailing colon', `${REMOTE_OVERRIDE_PHRASE}:`],
    ['reference with no phrase', UAT_REF],
    ['truthy string', 'true'],
    ['numeric truthy', '1'],
    ['yes', 'yes'],
    ['trailing whitespace', `${GOOD_OVERRIDE} `],
    ['leading whitespace', ` ${GOOD_OVERRIDE}`],
    ['internal whitespace', `${REMOTE_OVERRIDE_PHRASE}: ${UAT_REF}`],
    ['lowercased phrase', GOOD_OVERRIDE.toLowerCase()],
    ['uppercased reference', `${REMOTE_OVERRIDE_PHRASE}:${UAT_REF.toUpperCase()}`],
    ['reference prefix only', `${REMOTE_OVERRIDE_PHRASE}:${UAT_REF.slice(0, -1)}`],
    ['reference with a suffix', `${GOOD_OVERRIDE}extra`],
    ['wrong separator', `${REMOTE_OVERRIDE_PHRASE}=${UAT_REF}`],
    ['empty', ''],
    ['absent', undefined],
  ]

  for (const [label, value] of wrongValues) {
    test(`${label} → still blocked`, () => {
      assert.throws(() => assertTargetAllowed(UAT_URL, value), UatEnvError)
    })
  }

  test('the right value in the wrong variable does not unlock anything', () => {
    assert.throws(
      () => resolveUatEnv({ env: hostedEnv({ UAT_ALLOW: GOOD_OVERRIDE }), shellOverride: undefined }),
      UatEnvError,
    )
  })
})

describe('the override is honoured only from the shell, never from a dotenv file', () => {
  // resolveUatEnv reads the override from its own `shellOverride` argument —
  // the pre-dotenv snapshot — and never from `env`, which is what dotenv
  // populates. These cases put a perfectly correct override in the dotenv-fed
  // environment and prove it does nothing.
  for (const source of ['.env', '.env.local', '.env.production']) {
    test(`a correct override arriving via ${source} is ignored`, () => {
      assert.throws(
        () =>
          resolveUatEnv({
            env: hostedEnv({ [REMOTE_OVERRIDE_VAR]: GOOD_OVERRIDE }),
            shellOverride: undefined,
          }),
        UatEnvError,
      )
    })
  }

  test('a file value cannot override a wrong shell value', () => {
    assert.throws(
      () =>
        resolveUatEnv({
          env: hostedEnv({ [REMOTE_OVERRIDE_VAR]: GOOD_OVERRIDE }),
          shellOverride: 'true',
        }),
      UatEnvError,
    )
  })

  test('the shell value alone is enough — no file entry needed', () => {
    assert.doesNotThrow(() =>
      resolveUatEnv({ env: hostedEnv(), shellOverride: GOOD_OVERRIDE }),
    )
  })

  test('the snapshot is taken before dotenv runs', () => {
    const source = readFileSync(path.join(SCRIPTS_DIR, 'lib', 'uatEnv.mjs'), 'utf8')
    const snapshotAt = source.indexOf('const SHELL_REMOTE_OVERRIDE = process.env[')
    const firstConfigCall = source.indexOf('config({ path:')
    assert.ok(snapshotAt > -1, 'snapshot line not found')
    assert.ok(firstConfigCall > -1, 'dotenv call not found')
    assert.ok(snapshotAt < firstConfigCall, 'snapshot must precede every dotenv call')
  })
})

describe('the exact override proceeds only as far as a mocked client', () => {
  test('resolves, then hands the injected factory the configured values', () => {
    const resolved = resolveUatEnv({
      env: hostedEnv(),
      shellOverride: GOOD_OVERRIDE,
      requireAnonKey: true,
      requireUserPassword: true,
    })

    assert.equal(resolved.url, UAT_URL)
    assert.equal(resolved.serviceRoleKey, FAKE_SERVICE_KEY)
    assert.equal(resolved.anonKey, FAKE_ANON_KEY)
    assert.equal(resolved.userPassword, FAKE_PASSWORD)

    const calls = []
    const sentinel = { mocked: true }
    const client = createUatAdminClient(resolved, (url, key, options) => {
      calls.push({ url, key, options })
      return sentinel
    })

    assert.equal(client, sentinel)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, UAT_URL)
    assert.equal(calls[0].key, FAKE_SERVICE_KEY)
    assert.deepEqual(calls[0].options, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    // The fake factory returned a plain object, so nothing could have made a
    // request; the throwing global fetch would have caught it if it had.
  })

  test('a local target proceeds without any override', () => {
    const resolved = resolveUatEnv({ env: localEnv(), shellOverride: undefined })
    const client = createUatAdminClient(resolved, () => ({ mocked: true }))
    assert.deepEqual(client, { mocked: true })
  })
})

describe('no error or log carries a secret value', () => {
  const cases = [
    ['missing url', localEnv({ NEXT_PUBLIC_SUPABASE_URL: '' }), undefined],
    ['missing service key', localEnv({ SUPABASE_SERVICE_ROLE_KEY: '' }), undefined],
    ['missing anon key', localEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: '' }), undefined],
    ['missing password', localEnv({ UAT_USER_PASSWORD: '' }), undefined],
    ['blocked hosted target', hostedEnv(), undefined],
    ['wrong override', hostedEnv(), 'true'],
    ['override for another project', hostedEnv(), expectedOverrideFor(OTHER_REF)],
    ['override only in a dotenv file', hostedEnv({ [REMOTE_OVERRIDE_VAR]: GOOD_OVERRIDE }), undefined],
    ['unextractable reference', envFor('https://supabase.co'), GOOD_OVERRIDE],
    ['*.local target', envFor('http://supabase.local'), GOOD_OVERRIDE],
  ]

  for (const [label, env, shellOverride] of cases) {
    test(`${label} → message names variables, not values`, () => {
      let message = ''
      try {
        resolveUatEnv({ env, shellOverride, requireAnonKey: true, requireUserPassword: true })
        assert.fail('expected a UatEnvError')
      } catch (error) {
        assert.ok(error instanceof UatEnvError)
        message = `${error.message}\n${error.stack ?? ''}`
      }

      for (const secret of SECRETS) {
        assert.ok(!message.includes(secret), `message leaked ${secret}`)
      }
      for (const identifier of IDENTIFIERS) {
        assert.ok(!message.includes(identifier), `message leaked ${identifier}`)
      }
    })
  }

  test('the module source contains no credential-shaped literal', () => {
    const source = readFileSync(path.join(SCRIPTS_DIR, 'lib', 'uatEnv.mjs'), 'utf8')
    assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{10,}/, 'looks like an embedded JWT')
    assert.doesNotMatch(source, /https:\/\/[a-z0-9-]+\.supabase\.co/, 'embedded project URL')
  })
})

describe('all three scripts use the shared validation', () => {
  for (const name of UAT_SCRIPTS) {
    const source = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8')

    test(`${name} imports and calls the shared resolver`, () => {
      assert.match(source, /from '\.\/lib\/uatEnv\.mjs'/)
      assert.match(source, /resolveUatEnvOrExit\(/)
      assert.match(source, /createUatAdminClient\(/)
    })

    test(`${name} does not pass its own shellOverride, so the snapshot applies`, () => {
      assert.doesNotMatch(source, /shellOverride/)
    })

    test(`${name} carries no hard-coded credential or project URL`, () => {
      assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{10,}/, 'looks like an embedded JWT')
      assert.doesNotMatch(source, /https:\/\/[a-z0-9-]+\.supabase\.co/, 'embedded project URL')
      assert.doesNotMatch(source, /postgres(ql)?:\/\//, 'embedded connection string')
    })

    test(`${name} builds every client from resolved env values`, () => {
      // Every createClient call must take its URL/key from `env.*`, never a literal.
      for (const call of source.matchAll(/createClient\(\s*([^,)]+),\s*([^,)]+)/g)) {
        assert.match(call[1].trim(), /^env\./, `${name}: literal URL passed to createClient`)
        assert.match(call[2].trim(), /^env\./, `${name}: literal key passed to createClient`)
      }
    })
  }
})

describe('.env.example does not invite a stored override', () => {
  const example = readFileSync(path.join(path.dirname(SCRIPTS_DIR), '.env.example'), 'utf8')

  test('no uncomment-ready assignment of the override variable', () => {
    for (const line of example.split('\n')) {
      const bare = line.replace(/^#\s?/, '')
      assert.ok(
        !/^UAT_ALLOW_REMOTE_TARGET\s*=/.test(bare) || bare.includes('node scripts/'),
        `line reads as a settable env entry: ${line}`,
      )
    }
  })

  test('it says the override is ignored when stored in a file', () => {
    assert.match(example, /IGNORED/)
    assert.match(example, /\.env\.local/)
  })

  test('placeholders only — no real credential or project shape', () => {
    assert.doesNotMatch(example, /eyJ[A-Za-z0-9_-]{10,}/)
    assert.match(example, /your-project-ref/)
    assert.match(example, /your-uat-project-ref/)
  })
})
