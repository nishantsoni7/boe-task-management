/**
 * THE ONE PRIVILEGED CLIENT HELPER.
 *
 * Five properties, each asked directly rather than assumed:
 *
 *   1. the canonical credential name is the one BOE already uses
 *   2. this module can never enter a client bundle
 *   3. a missing credential is caught INSIDE the route boundary
 *   4. a configured credential still works
 *   5. no secret reaches a log or a response
 *
 * Run:
 *   npx tsx --test src/lib/supabase/adminClient.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ADMIN_CLIENT_ENV, adminClient, adminClientConfigured } from './admin'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const HELPER = readFileSync(join(SRC, 'lib/supabase/admin.ts'), 'utf8')
const ROUTE = readFileSync(join(SRC, 'app/api/orders/[id]/documents/route.ts'), 'utf8')

/**
 * The route with its comments stripped.
 *
 * Its header QUOTES the non-null assertion that caused the original bug, so
 * that the next reader understands what was wrong. A guard that searched the
 * raw text would read that explanation as the defect returning.
 */
const ROUTE_CODE = stripComments(ROUTE)

/** Source with block and line comments removed, so a guard reads code only. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
}

/** Every .ts/.tsx under src/, so a scan cannot miss a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}
const ALL_FILES = walk(SRC)

// ══ 1. The canonical credential ══════════════════════════════════════════════

describe('the credential BOE actually uses', () => {
  test('is SUPABASE_SERVICE_ROLE_KEY, and this helper reads that name', () => {
    assert.deepEqual([...ADMIN_CLIENT_ENV],
      ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])
    assert.ok(HELPER.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'))
  })

  test('NO OTHER server credential name exists anywhere in src/', () => {
    // The question this test settles: does some other route use a different
    // name, such that centralising on this one would need a second secret?
    // It does not. Asked of the whole tree rather than of memory.
    const variants = [
      'SUPABASE_SERVICE_ROLE_SECRET', 'SUPABASE_SECRET', 'SUPABASE_SERVICE_KEY',
      'SERVICE_ROLE_SECRET', 'SUPABASE_ADMIN_KEY', 'SUPABASE_PRIVATE_KEY',
    ]
    // CODE, NOT PROSE. Both this file and the helper NAME these variants — one
    // to search for them, the other to record that they do not exist — and a
    // raw-text scan would read those explanations as the thing they describe.
    // Stripping comments is the honest scope and it generalises: a future file
    // may explain the same history without becoming a violation.
    const found: string[] = []
    const SELF = 'src/lib/supabase/adminClient.test.ts'
    for (const file of ALL_FILES) {
      // This file must skip ITSELF, and comment-stripping cannot do it: the
      // list above is executable code, not prose. One exact path, not a
      // pattern, and nothing in this file constructs a client.
      if (relative(ROOT, file) === SELF) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const v of variants) {
        if (text.includes(v)) found.push(`${relative(ROOT, file)}: ${v}`)
      }
    }
    assert.deepEqual(found, [],
      'a second credential name exists; the canonical one is no longer canonical')
  })

  test('and it is the name .env.example documents', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
    assert.match(example, /^SUPABASE_SERVICE_ROLE_KEY=/m)
  })
})

// ══ 2. It cannot reach a browser ═════════════════════════════════════════════

describe('the helper never enters a client bundle', () => {
  const CLIENT_FILES = ALL_FILES.filter(f => {
    const head = readFileSync(f, 'utf8').slice(0, 400)
    return /^\s*['"]use client['"]/m.test(head)
  })

  test('there ARE client components to check, so this is not vacuous', () => {
    assert.ok(CLIENT_FILES.length > 20,
      `only ${CLIENT_FILES.length} client files found; the scan is probably broken`)
  })

  test('none of them imports it', () => {
    const offenders = CLIENT_FILES.filter(f => {
      const text = readFileSync(f, 'utf8')
      return /from\s+['"](@\/lib\/supabase\/admin|.*\/supabase\/admin)['"]/.test(text)
    }).map(f => relative(ROOT, f))
    assert.deepEqual(offenders, [])
  })

  test('none of them reads the raw credential either', () => {
    // The helper is the supported path, but centralising it must not create a
    // second, unwatched one.
    const offenders = CLIENT_FILES.filter(f =>
      readFileSync(f, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY')
    ).map(f => relative(ROOT, f))
    assert.deepEqual(offenders, [])
  })

  test('the helper itself carries no `use client` directive', () => {
    assert.ok(!/^\s*['"]use client['"]/m.test(HELPER.slice(0, 400)))
  })
})

// ══ 3. Missing configuration is caught inside the route boundary ═════════════

describe('a deployment with no credential', () => {
  test('the helper REPORTS it rather than throwing', () => {
    // The whole point. A throw from a client constructor escaped the route and
    // became a bare 500 with no message.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
      const result = adminClient()
      assert.equal(result.ok, false)
      assert.ok(!result.ok && result.missing.includes('SUPABASE_SERVICE_ROLE_KEY'))
      assert.equal(adminClientConfigured(), false)
    } finally {
      if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = url
      if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = key
    }
  })

  test('an EMPTY value counts as missing, not as a key', () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
      process.env.SUPABASE_SERVICE_ROLE_KEY = ''
      const result = adminClient()
      assert.equal(result.ok, false, 'an empty string would throw in supabase-js')
    } finally {
      if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = key
      if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = url
    }
  })

  test('the route checks BEFORE it uses the client', () => {
    const guard = ROUTE.indexOf('if (!admin.ok)')
    const use = ROUTE.indexOf('service\n    .rpc(')
    assert.ok(guard > 0, 'the route must handle the not-ok result')
    assert.ok(use === -1 || guard < use)
  })

  test('and answers with its own code, never a bare 500', () => {
    assert.ok(ROUTE.includes("'SERVER_NOT_CONFIGURED'"))
    assert.ok(ROUTE.includes('adminClient()'))
    assert.ok(!ROUTE_CODE.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'),
      'the route must reach the credential only through the helper')
  })
})

// ══ 4. A configured credential still works ═══════════════════════════════════

describe('a deployment WITH the credential', () => {
  test('builds a usable client', () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
      const result = adminClient()
      assert.equal(result.ok, true)
      assert.ok(result.ok && typeof result.client.rpc === 'function')
      assert.ok(result.ok && typeof result.client.from === 'function')
      assert.equal(adminClientConfigured(), true)
    } finally {
      if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = url
      if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = key
    }
  })
})

// ══ 5. No secret in a log or a response ══════════════════════════════════════

describe('what the helper is allowed to say', () => {
  test('it reports NAMES, never values', () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://secret-project.supabase.co'
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
      const result = adminClient()
      assert.equal(result.ok, false)
      const text = JSON.stringify(result)
      assert.ok(!text.includes('secret-project'),
        'the project URL leaked into the missing-config report')
      assert.ok(result.ok === false && result.missing.every(m => /^[A-Z_]+$/.test(m)),
        'missing must contain variable names only')
    } finally {
      if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = url
      if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = key
    }
  })

  test('the route logs the missing NAMES and returns none of them', () => {
    // An operator needs to know which setting is absent; a caller does not, and
    // telling them enumerates the deployment's configuration.
    assert.match(ROUTE, /console\.error\(.*not configured.*admin\.missing\.join/)
    const responses = [...ROUTE.matchAll(/NextResponse\.json\(([\s\S]*?)\)|fail\(([^)]*)\)/g)]
      .map(m => m[1] ?? m[2] ?? '')
    for (const body of responses) {
      for (const forbidden of ['admin.missing', 'SUPABASE_SERVICE_ROLE_KEY', 'process.env']) {
        assert.ok(!body.includes(forbidden), `a response carries ${forbidden}`)
      }
    }
  })

  test('the helper never logs at all', () => {
    // Deciding what an operator sees is the caller's job; a library that logs
    // for them writes into streams it does not own.
    assert.ok(!/console\.(log|error|warn|info)/.test(HELPER))
  })

  test('and never returns the key it read', () => {
    // Asked of the VALUE, not of the source text: the constructor legitimately
    // receives the key, so a grep for the word proves nothing either way.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    const SENTINEL = 'sbp-do-not-leak-me-0123456789'
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
      process.env.SUPABASE_SERVICE_ROLE_KEY = SENTINEL
      const result = adminClient()
      assert.equal(result.ok, true)
      // Every own enumerable property of the result, one level deep. The client
      // itself holds the key internally — that is what a client is for — so the
      // check is that the RESULT does not surface it as data.
      const shallow = result.ok
        ? { ok: result.ok, clientType: typeof result.client }
        : result
      assert.ok(!JSON.stringify(shallow).includes(SENTINEL))
      assert.ok(!Object.keys(result).some(k => (result as Record<string, unknown>)[k] === SENTINEL))
    } finally {
      if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = url
      if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = key
    }
  })
})
