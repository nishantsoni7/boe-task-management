/**
 * WHAT MAY BE REMEMBERED ABOUT A RECIPIENT, AND WHAT MAY NOT.
 *
 * Any valid number can now be typed, so the number is no longer necessarily a
 * colleague's — which makes "we do not keep it" the load-bearing promise of the
 * whole feature. This file is that promise, checked three ways:
 *
 *   1. the reduction itself — a fingerprint and four digits, and nothing that
 *      can be turned back into a number;
 *   2. the reduction FAILS CLOSED when it cannot be done;
 *   3. no full number appears in any column, parameter, log line, event or
 *      fixture in the module — checked by reading the files rather than by
 *      trusting the reading.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/recipientPrivacy.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprintRecipient } from './recipientPrivacy'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const KEY = 'SUPABASE_SERVICE_ROLE_KEY'
const E164 = '+919999900001'
const OTHER = '+919999900002'

/** Run something with a known credential in place, then put the world back. */
function withKey<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[KEY]
  try {
    if (value === undefined) delete process.env[KEY]
    else process.env[KEY] = value
    return fn()
  } finally {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  }
}

const fingerprintOf = (e164: string, key = 'test-key') =>
  withKey(key, () => {
    const result = fingerprintRecipient(e164)
    assert.equal(result.ok, true, `expected ${e164} to fingerprint`)
    return (result as Extract<typeof result, { ok: true }>).value
  })

describe('the reduction', () => {
  test('it produces a hex digest and four digits, and nothing else', () => {
    const value = fingerprintOf(E164)
    assert.deepEqual(Object.keys(value).sort(), ['fingerprint', 'lastFour'])
    assert.match(value.fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(value.lastFour, '0001')
  })

  test('THE NUMBER IS NOT RECOVERABLE FROM WHAT IS KEPT', () => {
    // Not a proof of irreversibility — that is a property of HMAC, not of a
    // test — but the check that matters in practice: no part of the number
    // beyond the last four survives in either field.
    const value = fingerprintOf(E164)
    assert.equal(value.fingerprint.includes('919999'), false)
    assert.equal(value.fingerprint.includes('99999'), false)
    assert.equal(value.lastFour.length, 4)
  })

  test('the same number always fingerprints the same, so recipients correlate', () => {
    assert.equal(fingerprintOf(E164).fingerprint, fingerprintOf(E164).fingerprint)
  })

  test('...and two numbers never share one', () => {
    assert.notEqual(fingerprintOf(E164).fingerprint, fingerprintOf(OTHER).fingerprint)
  })

  test('it is DEPLOYMENT-SCOPED, which is a stated consequence rather than a bug', () => {
    // Two deployments, or the same one after a credential rotation, produce
    // different fingerprints for one number. That is acceptable only because a
    // fingerprint is a convenience for correlating test rows and nothing
    // depends on it — which is what the module doc says.
    assert.notEqual(
      fingerprintOf(E164, 'key-one').fingerprint,
      fingerprintOf(E164, 'key-two').fingerprint,
    )
  })

  test('it takes the CANONICAL form, so one number has one fingerprint', () => {
    // Fingerprinting raw input would give '+91 99999 00001' and '+919999900001'
    // two fingerprints for one number, which would make the column useless for
    // the only thing it is for. The function refuses the un-normalised form
    // rather than silently hashing it.
    withKey('test-key', () => {
      const result = fingerprintRecipient('+91 99999 00001')
      assert.equal(result.ok, false)
      assert.equal((result as { reason: string }).reason, 'invalid_number')
    })
  })
})

describe('IT FAILS CLOSED', () => {
  test('with no credential there is no fingerprint, and the caller is told which', () => {
    withKey(undefined, () => {
      const result = fingerprintRecipient(E164)
      assert.equal(result.ok, false)
      assert.equal((result as { reason: string }).reason, 'unconfigured')
    })
  })

  test('an invalid number is refused rather than hashed', () => {
    withKey('test-key', () => {
      for (const bad of ['', 'nope', '919999900001', '+0123', '+91999990000123456']) {
        const result = fingerprintRecipient(bad)
        assert.equal(result.ok, false, bad)
        assert.equal((result as { reason: string }).reason, 'invalid_number', bad)
      }
    })
  })

  test('the failure carries a fixed word, never the number', () => {
    withKey('test-key', () => {
      const result = fingerprintRecipient('+0123')
      assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason'])
      assert.ok(['unconfigured', 'invalid_number'].includes((result as { reason: string }).reason))
    })
  })

  test('and the route refuses to record rather than storing something weaker', () => {
    const route = read('src/app/api/customer-reviews/whatsapp/route.ts')
    assert.ok(route.includes('const stored = fingerprintRecipient(normalized.e164)'))
    assert.ok(route.includes('if (!stored.ok) {'))
    assert.ok(route.includes('return fail(503, MESSAGES.unavailable)'))
  })
})

describe('NO FULL NUMBER IS PERSISTED, LOGGED OR FIXTURED', () => {
  const sql = read('supabase/migrations/20261017000000_customer_review_outreach.sql')
  const route = read('src/app/api/customer-reviews/whatsapp/route.ts')

  test('the card table has no column that could hold one', () => {
    const table = sql.slice(
      sql.indexOf('create table public.customer_review_test_cards'),
      sql.indexOf('create index customer_review_test_cards_status_idx'),
    )
    // The two that exist, and their shapes.
    assert.ok(table.includes('whatsapp_target_fingerprint text check ('))
    assert.ok(table.includes('whatsapp_target_last_four text check ('))
    assert.ok(table.includes("whatsapp_target_fingerprint ~ '^[0-9a-f]{64}$'"))
    assert.ok(table.includes("whatsapp_target_last_four ~ '^[0-9]{4}$'"))
    // And the one that must not: a bare `whatsapp_target` holding E.164.
    assert.equal(/^\s{2}whatsapp_target\s+text/m.test(table), false,
      'a column that could hold a full number is back')
    assert.equal(table.includes("~ '^\\+[1-9][0-9]{7,14}$'"), false,
      'a column is constrained to E.164, which means it holds a number')
  })

  test('THE RPC HAS NO PARAMETER A NUMBER COULD ARRIVE IN', () => {
    // The structural half: SQL never sees a number because there is nowhere in
    // the signature to put one.
    const fn = /create or replace function public\.record_customer_review_test_card_whatsapp_opened\(([\s\S]*?)\)/
      .exec(sql)?.[1] ?? ''
    assert.ok(fn, 'the RPC is missing')
    const params = [...fn.matchAll(/(\w+)\s+(uuid|text)/g)].map(m => m[1])
    assert.deepEqual(params, ['p_card_id', 'p_target_fingerprint', 'p_target_last_four', 'p_actor_id'])
    // Both text parameters are shape-guarded to a form a number cannot take.
    assert.ok(sql.includes("p_target_fingerprint !~ '^[0-9a-f]{64}$'"))
    assert.ok(sql.includes("p_target_last_four !~ '^[0-9]{4}$'"))
  })

  test('the trail entry names no recipient at all', () => {
    assert.ok(sql.includes("'A wa.me link was built and opened. This does not confirm the message was sent.'"))
    // The event detail is a constant. Nothing interpolates into it.
    const event = sql.slice(sql.indexOf("(p_card_id, 'whatsapp_opened',"))
    assert.equal(/%/.test(event.slice(0, 200)), false, 'the trail detail interpolates something')
  })

  test('NO LOG LINE IN THE ROUTE CAN CARRY A NUMBER', () => {
    for (const line of route.split('\n').filter(l => l.includes('console.'))) {
      assert.equal(/typedNumber|normalized\.e164|normalized\.digits|number/i.test(line), false,
        `a log line references the number: ${line.trim()}`)
    }
    // The error path logs a CODE, not a message that could quote a parameter.
    assert.ok(route.includes('error.code'))
    assert.equal(route.includes('error.message'), false)
  })

  test('the response echoes only the last four', () => {
    // Asserted on the SHAPE of the returned object, not on whether the source
    // mentions `e164` — the expression that produces the four digits slices
    // them off the E.164 value, so a name search finds it and calls it a leak.
    assert.ok(route.includes('target: { lastFour: normalized.e164.slice(-4) }'))

    const body = route.slice(route.indexOf('return ok({'), route.lastIndexOf('})'))
    const target = /target:\s*\{([^}]*)\}/.exec(body)?.[1] ?? ''
    assert.ok(target, 'the response has no target field')
    const keys = [...target.matchAll(/(\w+):/g)].map(m => m[1])
    assert.deepEqual(keys, ['lastFour'], 'the response returns more than the last four')
  })

  test('NO FIXTURE CONTAINS A PHONE NUMBER', () => {
    for (const file of readdirSync(join(ROOT, 'supabase/fixtures'))) {
      const source = read(`supabase/fixtures/${file}`)
      assert.equal(/\+\d[\d\s()-]{7,}/.test(source), false, `${file} contains a number`)
    }
  })

  test('THE MIGRATION CONTAINS NO NUMBER AT ALL', () => {
    // Nothing in the schema stores one, so nothing in the schema needs to name
    // one — not in a column, not in a constraint, not in an example.
    const found = [...sql.matchAll(/\+\d[\d\s]{9,}/g)].map(m => m[0].replace(/\s/g, ''))
    assert.deepEqual(found, [], `the migration contains: ${found.join(', ')}`)
  })

  test('and the harness never HANDS a number to anything that stores it', () => {
    // Stated precisely, because the blunt version of this assertion was wrong.
    //
    // The harness DOES contain one number — as the value in a negative
    // assertion that proves the fingerprint column refuses a phone number
    // outright. Forbidding the string would have deleted the test that proves
    // the property. What must be true is narrower and is what is checked: every
    // call to the recording function passes reduced forms, and the one number
    // present is one the database is being asked to reject.
    const harness = read('supabase/tests/customer_review_test_card_assertions.sql')

    for (const call of harness.matchAll(
      /record_customer_review_test_card_whatsapp_opened\(([\s\S]*?)\);/g,
    )) {
      assert.equal(/\+\d[\d\s]{7,}/.test(call[1]), false,
        `a number is passed to the recorder: ${call[1].trim()}`)
    }

    const numbers = [...harness.matchAll(/'\+\d[\d\s]{7,}'/g)].map(m => m[0])
    for (const number of numbers) {
      const at = harness.indexOf(number)
      const following = harness.slice(at, at + 600)
      assert.ok(
        following.includes('raise exception') && following.includes('exception when sqlstate'),
        `${number} appears outside a block that expects it to be refused`,
      )
    }
  })
})

describe('the fingerprint is honest about what it is', () => {
  test('the file says a bare digest would not have been enough', () => {
    // The comment is the deliverable here: somebody reading this column later
    // must not believe it is stronger than it is.
    // Read as PROSE. The header wraps at 79 characters, so a sentence a test
    // wants to find is split across two lines — each continuation starting with
    // its own `//` — and matches nothing when searched for whole.
    const prose = read('src/lib/customerReviews/recipientPrivacy.ts')
      .split('\n')
      .map(l => l.replace(/^\s*\/\/\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
    assert.ok(prose.includes('A bare digest of a phone number is not a secret'))
    assert.ok(prose.includes('does NOT make the fingerprint secret'))
    assert.ok(prose.includes('deployment-scoped'))
  })

  test('it is keyed, domain-separated, and uses the existing server credential', () => {
    const source = read('src/lib/customerReviews/recipientPrivacy.ts')
    assert.ok(source.includes("createHmac('sha256', key)"))
    assert.ok(source.includes('boe:customer-review-test-card:recipient:v1'))
    assert.ok(source.includes("const KEY_ENV_VAR = 'SUPABASE_SERVICE_ROLE_KEY'"))
    // No new secret was invented for this.
    assert.equal(/process\.env\['?BOE_/.test(source), false)
  })
})
