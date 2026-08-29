/**
 * THE SECURITY CONTRACT of 20261017000000, asserted function by function and
 * policy by policy.
 *
 * migration.test.ts audits the module's SHAPE — what exists, and that the SQL
 * transition table matches the browser's. This file audits the properties that
 * make it safe: every SECURITY DEFINER function pins its search_path, derives
 * its actor from auth.uid() alone, locks the row before a lifecycle change,
 * cannot be aimed at somebody else, cannot be executed by anon, and cannot leak
 * private data in a raised error.
 *
 * A SECURITY DEFINER function is the one place in this codebase where a caller
 * runs as the table owner. Every one of them is therefore a potential privilege
 * escalation, and "it looked fine when I wrote it" is not a control. This is.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/securityContract.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sql = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'),
  'utf8',
).replace(/\r\n/g, '\n')
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** Every function this migration defines, with its body. */
function definitions(): { name: string; args: string; body: string }[] {
  const out: { name: string; args: string; body: string }[] = []
  const re = /create or replace function public\.(\w+)\(([^)]*)\)/g
  for (const match of code.matchAll(re)) {
    const start = match.index!
    const tag = /\$[A-Za-z_]*\$/.exec(code.slice(start))![0]
    const open = code.indexOf(tag, start)
    const close = code.indexOf(tag, open + tag.length)
    out.push({ name: match[1], args: match[2], body: code.slice(start, close + tag.length) })
  }
  return out
}

const FUNCTIONS = definitions()
const byName = (name: string) => {
  const fn = FUNCTIONS.find(f => f.name === name)
  assert.ok(fn, `${name} is missing`)
  return fn!
}

/**
 * The functions a CLIENT may call, and the functions only the definer chain
 * may. Naming both halves is the point: a function that moved from one list to
 * the other without anybody noticing is exactly the failure this catches.
 */
const CLIENT_CALLABLE = [
  'customer_review_internal_test_warning',
  'can_use_customer_review_test_cards',
  'can_view_customer_review_test_card',
  'can_view_customer_review_test_card_row',
  'book_customer_review_test_card',
  'confirm_customer_review_test_card_sent',
  'transition_customer_review_test_card',
]

const INTERNAL_ONLY = [
  'assert_customer_review_test_card_submittable',
  'customer_review_test_screenshots_log_removal',
]

/**
 * Reachable by service_role ALONE. Each takes something the TRUSTED ROUTE
 * establishes — the actor from the session, or the recipient already reduced to
 * a fingerprint and four digits — so a browser able to call any of them could
 * supply either itself.
 */
const SERVICE_ROLE_ONLY = [
  'record_customer_review_test_card_whatsapp_opened',
  'begin_customer_review_test_screenshot_removal',
  'finish_customer_review_test_screenshot_removal',
]

/** Functions that CHANGE the card's lifecycle, and so must lock the row. */
const LIFECYCLE_WRITERS = [
  'transition_customer_review_test_card',
  'confirm_customer_review_test_card_sent',
  'record_customer_review_test_card_whatsapp_opened',
]

describe('the function inventory is exactly what is expected', () => {
  test('every function is accounted for in one list or the other', () => {
    assert.deepEqual(
      FUNCTIONS.map(f => f.name).sort(),
      [...CLIENT_CALLABLE, ...INTERNAL_ONLY, ...SERVICE_ROLE_ONLY].sort(),
    )
  })
})

describe('search_path is pinned on every function', () => {
  test('each one sets it, and to the same safe value', () => {
    // Without this a caller can put a schema of their own in front of `public`
    // and have the definer body resolve `users` — running as the table owner —
    // to a table they control.
    for (const fn of FUNCTIONS) {
      assert.ok(
        /set search_path = public, pg_temp/.test(fn.body),
        `${fn.name} does not pin search_path`,
      )
    }
  })

  test('pg_temp is LAST, so a temporary object cannot shadow a real one', () => {
    for (const fn of FUNCTIONS) {
      assert.equal(
        /set search_path = pg_temp/.test(fn.body), false,
        `${fn.name} puts pg_temp first`,
      )
    }
  })
})

describe('grants: who can execute what', () => {
  test('every client-callable function is revoked from public and anon first', () => {
    for (const name of CLIENT_CALLABLE) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon`)
      assert.ok(revoke.test(code), `${name} is not revoked from public, anon`)
    }
  })

  test('…and then granted to authenticated, and to nothing else', () => {
    for (const name of CLIENT_CALLABLE) {
      const grant = new RegExp(`grant\\s+execute on function public\\.${name}\\([^)]*\\) to authenticated`)
      assert.ok(grant.test(code), `${name} is not granted to authenticated`)
    }
    // No client role beyond `authenticated` is ever named in a grant.
    for (const match of code.matchAll(/grant\s+execute on function[^;]*;/g)) {
      assert.equal(/\banon\b/.test(match[0]), false, match[0])
      assert.equal(/\bpublic\b(?!\.)/.test(match[0].replace(/public\./g, '')), false, match[0])
    }
  })

  test('every internal function is revoked from authenticated as well', () => {
    // These run only inside the definer chain or as a trigger. A client that
    // could call the submission guard directly would learn the state of a card
    // it may not see; one that could call the log-writing trigger function
    // could forge a trail row.
    for (const name of INTERNAL_ONLY) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`)
      assert.ok(revoke.test(code), `${name} is not revoked from authenticated`)
    }
  })

  test('service_role is granted EXACTLY those three, and nothing else', () => {
    // A grant to service_role is a statement that something privileged depends
    // on it. Three things do, and all three are named.
    const granted = [...code.matchAll(/grant\s+execute on function public\.(\w+)\([^)]*\)\s*\n?\s*to service_role/g)]
      .map(m => m[1]).sort()
    assert.deepEqual(
      granted.filter(n => !CLIENT_CALLABLE.includes(n)),
      [...SERVICE_ROLE_ONLY].sort(),
    )
    for (const name of SERVICE_ROLE_ONLY) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`)
      assert.ok(revoke.test(code), `${name} is not revoked from authenticated`)
    }
  })

  test('the ORDER is revoke-then-grant, never the reverse', () => {
    for (const name of [...CLIENT_CALLABLE, ...SERVICE_ROLE_ONLY]) {
      const revokeAt = code.indexOf(`revoke execute on function public.${name}(`)
      const grantAt = code.indexOf(`grant  execute on function public.${name}(`)
      assert.notEqual(revokeAt, -1, `${name} is never revoked`)
      assert.notEqual(grantAt, -1, `${name} is never granted`)
      assert.ok(revokeAt < grantAt, `${name} grants before it revokes`)
    }
  })
})

describe('identity: who the function thinks it is acting for', () => {
  test('no BROWSER-CALLABLE function accepts a user id — the actor is auth.uid()', () => {
    // A p_user_id parameter on a browser-callable function is how one employee
    // acts as another, and how they interrogate the permission engine about a
    // colleague one call at a time.
    for (const name of CLIENT_CALLABLE) {
      const fn = byName(name)
      assert.equal(/p_user_id|p_actor_id|p_acting/.test(fn.args), false,
        `${name} exposes an acting-user parameter to a browser`)
    }
  })

  test('the three service-role functions DO take an actor, and cannot be reached', () => {
    // They take one BECAUSE the trusted route establishes it from the session.
    // That is only safe while no browser role can call them, which is asserted
    // in the grants section above and re-asserted here at the signature.
    for (const name of ['record_customer_review_test_card_whatsapp_opened',
                        'begin_customer_review_test_screenshot_removal']) {
      assert.ok(/p_actor_id\s+uuid/.test(byName(name).args), `${name} does not take an explicit actor`)
      const grant = new RegExp(`grant\\s+execute on function public\\.${name}\\([^)]*\\)[^;]*to authenticated`)
      assert.equal(grant.test(code), false, `${name} is granted to authenticated`)
    }
  })

  test('every browser-callable predicate derives the caller itself', () => {
    for (const name of [
      'can_use_customer_review_test_cards',
      'can_view_customer_review_test_card',
      'can_view_customer_review_test_card_row',
      'book_customer_review_test_card',
      'confirm_customer_review_test_card_sent',
    ]) {
      const fn = byName(name)
      assert.ok(fn.body.includes('auth.uid()'), `${name} must derive the caller itself`)
    }
  })

  test('a signed-out caller is refused before anything else happens', () => {
    for (const name of ['transition_customer_review_test_card',
                        'confirm_customer_review_test_card_sent',
                        'book_customer_review_test_card']) {
      const body = byName(name).body
      assert.ok(body.includes('if v_uid is null then'), `${name} does not reject a null identity`)
      assert.ok(body.includes('CUSTOMER_REVIEW_TEST_UNAUTHORIZED'), name)
    }
  })

  test('an INACTIVE employee is refused, whatever the permission engine says', () => {
    // resolve_effective_permissions does not check users.is_active, so every
    // function in this module has to.
    for (const name of [...LIFECYCLE_WRITERS,
                        'book_customer_review_test_card',
                        'can_use_customer_review_test_cards',
                        'can_view_customer_review_test_card',
                        'can_view_customer_review_test_card_row',
                        'begin_customer_review_test_screenshot_removal']) {
      assert.ok(byName(name).body.includes('is_active'), `${name} does not check is_active`)
    }
  })

  // The pair below used to assert a NULL check on v_admin: the role was read
  // with SELECT ... INTO, and a missing row left it NULL rather than false. No
  // role is read anywhere in this module now, so the question is asked directly
  // — "is there an active row for this person" — and a missing row is simply
  // not-exists. The property under test is unchanged; only the shape is.
  test('the transition refuses when the caller has no active user row at all', () => {
    const body = byName('transition_customer_review_test_card').body
    assert.ok(body.includes('select 1 from public.users u where u.id = v_uid and u.is_active'))
    assert.ok(body.includes("CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active"))
    assert.equal(body.includes('v_admin'), false, 'the transition still reads a role')
  })

  test('the removal half refuses an inactive actor the same way', () => {
    const body = byName('begin_customer_review_test_screenshot_removal').body
    assert.ok(body.includes('select 1 from public.users u where u.id = p_actor_id and u.is_active'))
    assert.ok(body.includes("CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active"))
    assert.equal(body.includes('v_admin'), false, 'the removal function still reads a role')
  })
})

describe('races: two clicks cannot both win', () => {
  test('every lifecycle writer locks the row it is about to change', () => {
    for (const name of LIFECYCLE_WRITERS) {
      assert.ok(
        byName(name).body.includes('where id = p_card_id for update'),
        `${name} does not take a row lock`,
      )
    }
  })

  test('the lock is taken BEFORE the status is read, not after', () => {
    const body = byName('transition_customer_review_test_card').body
    const lock = body.indexOf('for update')
    const guard = body.indexOf('v_legal := case c.status')
    assert.ok(lock !== -1 && guard !== -1 && lock < guard,
      'the legality guard must read a locked row')
  })

  test('BOOKING does the opposite, and that is the correct opposite', () => {
    // Every other writer reads-then-locks-then-decides. Booking cannot: the row
    // belongs to nobody, so there is nothing to lock that would help. It claims
    // the row with a single conditional UPDATE instead, and a concurrent caller
    // re-evaluates `status = 'available'` against the committed new version.
    const body = byName('book_customer_review_test_card').body
    assert.equal(body.includes('for update'), false,
      'booking takes a lock, which is one step too late to win a race')
    assert.ok(/update public\.customer_review_test_cards[\s\S]*?and status = 'available'/.test(body))
    assert.ok(body.includes('if not found then'))
  })

  test('a duplicate transition is refused by the table, not merely ignored', () => {
    // The second caller wakes on a row whose status has already moved, so its
    // move is no longer legal and it raises. There is no ON CONFLICT and no
    // silent no-op anywhere in the function.
    const body = byName('transition_customer_review_test_card').body
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_BAD_TRANSITION'))
    assert.equal(/on conflict/i.test(body), false)
  })

  test('confirming twice keeps the FIRST claim', () => {
    // Idempotent rather than last-write-wins: a later click must not quietly
    // move a timestamp somebody may already have been shown.
    const body = byName('confirm_customer_review_test_card_sent').body
    assert.ok(body.includes('if c.sent_confirmed_at is null then'))
  })
})

describe('mass assignment and field forgery', () => {
  test('the transition accepts three parameters and no field map', () => {
    const fn = byName('transition_customer_review_test_card')
    const params = fn.args.split(',').map(a => a.trim().split(/\s+/)[0]).filter(Boolean)
    assert.deepEqual(params, ['p_card_id', 'p_next_status', 'p_detail'])
    // No jsonb payload that could carry arbitrary columns.
    assert.equal(/jsonb/.test(fn.args), false)
  })

  test('every actor and timestamp it writes is derived, never passed in', () => {
    const body = byName('transition_customer_review_test_card').body
    for (const pair of [
      ['submitted_at', 'now()'], ['submitted_by', 'v_uid'],
      ['verified_at', 'now()'], ['verified_by', 'v_uid'],
      ['returned_at', 'now()'], ['returned_by', 'v_uid'],
    ] as const) {
      const line = body.split('\n').find(l => l.trim().startsWith(pair[0]))
      assert.ok(line, `${pair[0]} is not assigned`)
      assert.ok(line!.includes(pair[1]), `${pair[0]} is not set from ${pair[1]}: ${line!.trim()}`)
    }
  })

  test('booked_by is only ever auth.uid(), and only in the booking function', () => {
    // The requirement in one assertion: booking assigns the AUTHENTICATED
    // employee, never a caller-supplied actor.
    for (const fn of FUNCTIONS) {
      for (const chunk of fn.body.split('update public.customer_review_test_cards').slice(1)) {
        const setClause = chunk.slice(0, chunk.indexOf('where'))
        if (!/\bbooked_by\b/.test(setClause)) continue
        assert.equal(fn.name, 'book_customer_review_test_card',
          `${fn.name} writes booked_by`)
        assert.ok(/booked_by = v_uid/.test(setClause),
          'booked_by is not set from auth.uid()')
      }
    }
    assert.ok(byName('book_customer_review_test_card').body.includes('v_uid uuid := auth.uid()'))
  })

  test('card_ref, test_category, test_title and test_body are never written by any function', () => {
    // The mandatory label cannot be removed because the text it attaches to
    // cannot be written. This is that claim, checked against every function.
    for (const fn of FUNCTIONS) {
      for (const chunk of fn.body.split('update public.customer_review_test_cards').slice(1)) {
        const setClause = chunk.slice(0, chunk.indexOf('where'))
        for (const column of ['card_ref', 'test_category', 'test_title', 'test_body']) {
          assert.equal(new RegExp(`\\b${column}\\b`).test(setClause), false,
            `${fn.name} writes ${column}`)
        }
      }
    }
  })

  test('THE CARD TABLE HAS NO CLIENT WRITE PRIVILEGE AT ALL', () => {
    // There is no column grant to audit, because there is no grant. That is
    // stronger than the narrowest possible grant would be.
    assert.equal(
      /grant update \([\s\S]{0,600}?\) on public\.customer_review_test_cards/.test(code), false,
      'a column UPDATE grant exists on the card table',
    )
    assert.ok(
      /revoke insert, update, delete, truncate, references, trigger\s+on public\.customer_review_test_cards from authenticated, anon/.test(code),
    )
  })

  test('there is no INSERT policy to forge a row through', () => {
    assert.equal(
      /create policy "[^"]*"\s+on public\.customer_review_test_cards\s+for insert/.test(code), false,
      'a client can insert a card',
    )
  })
})

describe('errors say what happened without saying who to', () => {
  test('no raised message interpolates a recipient or a filename', () => {
    const raises = [...code.matchAll(/raise exception '([^']*)'([^;]*)/g)]
    assert.ok(raises.length >= 10)
    for (const [, message, tail] of raises) {
      for (const field of ['whatsapp_target', 'p_target', 'file_name', 'storage_path', 'test_body']) {
        assert.equal(tail.includes(field), false, `a raise interpolates ${field}: ${message}`)
      }
    }
  })

  test('the only values interpolated are a status and the caller’s own input', () => {
    const body = byName('transition_customer_review_test_card').body
    const raise = body.split('\n').find(l => l.includes('CUSTOMER_REVIEW_TEST_BAD_TRANSITION'))!
    const args = body.slice(body.indexOf(raise)).split('\n')[0]
    assert.ok(args.includes('c.status'))
    assert.ok(args.includes('p_next_status'))
  })

  test('every raise INSIDE A FUNCTION carries an SQLSTATE a caller can branch on', () => {
    // A bare RAISE surfaces as P0001, which is indistinguishable from any other
    // application error. Authorization is 42501, a refused value is 23514, and
    // a missing row is P0002. The live-database assertions check the exact code
    // for each refusal; this checks that one was chosen at all.
    //
    // Scoped to function bodies deliberately. The migration's own §12
    // assertions also raise, and those are apply-time failures nobody catches —
    // giving them an API errcode would pretend they are the same kind of event.
    for (const fn of FUNCTIONS) {
      for (const block of fn.body.split('raise exception').slice(1)) {
        assert.ok(
          /using errcode = '(42501|23514|P0002)'/.test(block.slice(0, 400)),
          `${fn.name}: ${block.split('\n')[0].trim()}`,
        )
      }
    }
  })
})

describe('permission enforcement inside the functions', () => {
  test('verifying and returning require `verify`, and nothing else does', () => {
    const body = byName('transition_customer_review_test_card').body
    assert.ok(body.includes("if p_next_status in ('verified', 'booked') then"))
    assert.ok(body.includes('if not v_verify then'))

    // EVERY OTHER MOVE NEEDS BOTH HALVES AND NOTHING ELSE. The disjunct that
    // stood here was `v_admin or (v_holder and v_use)`, which let an
    // administrator submit a test they did not run. Its removal is the whole
    // of this correction on the transition side.
    assert.ok(body.includes('if not (v_holder and v_use) then'))
    assert.equal(body.includes('v_admin'), false,
      'the transition still has an administrator escape hatch')
    assert.ok(body.includes("Only the tester holding this card can submit it"))
  })

  test('SUBMITTING IS THE HOLDER’S, and the two facts it needs are separate', () => {
    const body = byName('transition_customer_review_test_card').body
    // Holding is a comparison against the row, not a permission; `use` is a
    // permission, not an identity. Requiring only one of them would be a
    // different rule, so both are asserted where they are computed.
    assert.ok(body.includes('v_holder := (c.booked_by = v_uid);'))
    assert.ok(body.includes("v_use    := public.resolve_permission(v_uid, 'customer_review_requests', 'use');"))
  })

  test('THE VERIFY BRANCH IS THE ONLY PLACE A NON-HOLDER PASSES', () => {
    // Stated as a whole-function property rather than by matching one line: the
    // only authorization outcome that does not require v_holder is the one
    // guarded by p_next_status in ('verified', 'booked').
    const body = byName('transition_customer_review_test_card').body
    const gate = body.slice(body.indexOf("if p_next_status in ('verified', 'booked') then"))
    const elseAt = gate.indexOf('else')
    const verifyBranch = gate.slice(0, elseAt)
    const otherBranch = gate.slice(elseAt)
    assert.equal(verifyBranch.includes('v_holder'), false,
      'verifying a card wrongly requires holding it')
    assert.ok(otherBranch.includes('v_holder'),
      'a non-verifier move does not require holding the card')
  })

  test('booking requires `use` — a verifier alone cannot take a card', () => {
    // The separation the workflow exists to exercise: the person who checks a
    // test does not run it.
    const body = byName('book_customer_review_test_card').body
    assert.ok(body.includes("'customer_review_requests', 'use'"))
    assert.equal(body.includes("'customer_review_requests', 'verify'"), false,
      'a verifier can book, which removes the only separation the workflow has')
  })

  test('opening WhatsApp and confirming a send are holder-only, never verifier', () => {
    for (const name of ['record_customer_review_test_card_whatsapp_opened',
                        'confirm_customer_review_test_card_sent']) {
      const body = byName(name).body
      assert.ok(body.includes('c.booked_by ='), name)
      assert.ok(body.includes("'customer_review_requests', 'use'"), name)
      assert.equal(body.includes("'customer_review_requests', 'verify'"), false,
        `${name} must not admit a verifier`)
    }
  })

  test('OPENING WHATSAPP MOVES NO STATUS, and neither does confirming', () => {
    // The single most important negative in the module, asserted on both
    // functions: the whole point of separating them is that neither is a
    // lifecycle move.
    for (const name of ['record_customer_review_test_card_whatsapp_opened',
                        'confirm_customer_review_test_card_sent']) {
      const body = byName(name).body
      for (const chunk of body.split('update public.customer_review_test_cards').slice(1)) {
        const setClause = chunk.slice(0, chunk.indexOf('where'))
        assert.equal(/\bstatus\s*=/.test(setClause), false, `${name} assigns a status`)
      }
    }
  })

  test('a card can only be worked on while it is booked', () => {
    for (const name of ['record_customer_review_test_card_whatsapp_opened',
                        'confirm_customer_review_test_card_sent']) {
      assert.ok(byName(name).body.includes("c.status <> 'booked'"), name)
    }
  })

  test('the submission guard requires the tester’s claim AND a screenshot', () => {
    const body = byName('assert_customer_review_test_card_submittable').body
    assert.ok(body.includes('c.sent_confirmed_at is null'))
    assert.ok(body.includes('from public.customer_review_test_card_screenshots s'))
    assert.ok(body.includes('s.removal_started_at is null'),
      'a screenshot on its way out would count as evidence')
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_NOT_READY'))
  })

  test('confirming requires that a link was built first', () => {
    // An ORDERING constraint, not evidence. There is nothing to have sent if no
    // link was ever built — and the open still confirms nothing by itself.
    assert.ok(byName('confirm_customer_review_test_card_sent').body.includes('c.whatsapp_opened_at is null'))
  })
})

// ── RLS and storage ─────────────────────────────────────────────────────────

describe('who can read a card', () => {
  const rowFn = byName('can_view_customer_review_test_card_row').body

  test('a `use` holder reads THEIR OWN and the unbooked pool, and nothing else', () => {
    assert.ok(rowFn.includes('p_booked_by = auth.uid()'))
    // `use` is absent from the ROW predicate on purpose: holding it opens the
    // module and shows the pool, it does not disclose every colleague's work.
    assert.equal(rowFn.includes("'customer_review_requests', 'use'"), false)
  })

  test('a verifier reads every card, because verification requires it', () => {
    assert.ok(rowFn.includes("resolve_permission(auth.uid(), 'customer_review_requests', 'verify')"))
  })

  test('an unauthorized caller matches no branch, so the policy yields no row', () => {
    // The predicate is a closed list: holder, admin, verifier. There is no
    // fallback and no `or true`.
    const branches = rowFn.slice(rowFn.indexOf('and ('), rowFn.indexOf('  );'))
    assert.equal(/\btrue\b/.test(branches), false)
    assert.equal((branches.match(/\bor\b/g) ?? []).length, 2, 'exactly three branches')
  })

  test('the card table asks the same question WITHOUT re-reading itself', () => {
    const body = code.slice(code.indexOf('create policy "customer_review_test_cards_select"'))
    const policy = body.slice(0, body.indexOf(';'))

    assert.equal(/can_view_customer_review_test_card\(/.test(policy), false,
      'the card SELECT policy must not re-query its own table')
    assert.equal(/\bfrom\s+(public\.)?users\b/i.test(policy), false,
      'the card SELECT policy must not read users as the caller')
    assert.ok(policy.includes('can_view_customer_review_test_card_row('))
    assert.ok(policy.includes('can_use_customer_review_test_cards()'),
      'the available pool must be gated on an authorization check')
    assert.ok(policy.includes('customer_review_test_cards.booked_by'),
      'the candidate column must be qualified')
    assert.equal(/\btrue\b/.test(policy), false)

    assert.ok(rowFn.includes('security definer'), 'must have definer rights')
    assert.ok(rowFn.includes('set search_path = public, pg_temp'), 'must pin search_path')
    assert.ok(rowFn.includes('u.is_active'), 'a deactivated employee keeps nothing')
  })

  test('the child tables read through the card-id predicate', () => {
    for (const policy of [
      'customer_review_test_screenshots_select',
      'customer_review_test_events_select',
    ]) {
      const body = code.slice(code.indexOf(`create policy "${policy}"`))
      assert.ok(body.slice(0, body.indexOf(';')).includes('can_view_customer_review_test_card('), policy)
    }
  })
})

describe('storage: an object cannot be attached to somebody else’s card', () => {
  const policy = (name: string) => {
    const start = code.indexOf(`create policy "${name}"`)
    assert.notEqual(start, -1, name)
    return code.slice(start, code.indexOf(';', start))
  }

  test('the object path is the authorization, and it is the card id', () => {
    const body = policy('customer_review_test_screenshots_storage_select')
    assert.ok(body.includes("bucket_id = 'customer-review-test-screenshots'"))
    // Reading resolves the card out of the first path segment. It is the only
    // client policy on this bucket.
    assert.ok(body.includes("split_part(storage.objects.name, '/', 1)"))
  })

  test('NO CLIENT CAN UPLOAD, REGISTER OR REMOVE AN IMAGE', () => {
    // The absences that make /api/customer-reviews/photos the only writer, and
    // therefore make both its byte inspection and its removal a boundary rather
    // than advice.
    assert.equal(
      /create policy "[^"]*"\s+on storage\.objects\s+for (insert|delete)/.test(code), false,
      'a client INSERT or DELETE policy exists on the bucket',
    )
    assert.equal(
      /create policy "[^"]*"\s+on public\.customer_review_test_card_screenshots\s+for (insert|delete|update)/.test(code),
      false,
      'a client write policy exists on the screenshot table',
    )
    // Belt to those braces: every write privilege is revoked as well, so a
    // policy added back by mistake still could not write.
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate\n  on public.customer_review_test_card_screenshots from authenticated, anon',
    ))
  })

  test('METADATA CANNOT POINT AT ANOTHER CARD’S OBJECT', () => {
    // The route generates the key, and the schema refuses a row that disagrees
    // with it: the first path segment must equal the card id, the path is
    // UNIQUE so an object cannot be claimed twice, and the same bytes cannot be
    // registered twice against one card.
    assert.ok(code.includes('constraint customer_review_screenshot_path_matches_card check ('))
    assert.ok(code.includes("split_part(storage_path, '/', 1) = card_id::text"))
    assert.ok(code.includes('storage_path text not null unique'))

    // Content uniqueness moved from a table constraint to a PARTIAL index, and
    // that is a behaviour change rather than a tidy-up: the constraint counted
    // rows already marked for removal, so a failed object deletion left a card
    // unable to accept the very file a person would retry with.
    assert.equal(code.includes('constraint customer_review_screenshot_unique_content_per_card'), false)
    assert.ok(code.includes(
      'create unique index customer_review_screenshot_unique_live_content\n' +
      '  on public.customer_review_test_card_screenshots (card_id, content_sha256)\n' +
      '  where removal_started_at is null;'))
  })

  test('ONE LIVE SCREENSHOT PER CARD IS A DATABASE RULE, not a route’s count', () => {
    // MAX_TEST_SCREENSHOTS = 1 was enforced by reading a count and then
    // inserting. Two concurrent uploads with different content both read zero
    // and both inserted; only the index below actually prevents that.
    assert.ok(code.includes(
      'create unique index customer_review_screenshot_one_live_per_card\n' +
      '  on public.customer_review_test_card_screenshots (card_id)\n' +
      '  where removal_started_at is null;'))
  })

  test('the stored type and size are FACTS the server established', () => {
    assert.ok(code.includes("content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$')"))
  })

  test('a path with no separator is rejected outright', () => {
    // Otherwise split_part returns the whole string and the constraint could be
    // satisfied by a bare filename sitting at the bucket root.
    assert.ok(code.includes("position('/' in storage_path) > 1"))
  })

  test('type and size are enforced by the bucket AND by the row', () => {
    assert.ok(code.includes("array['image/jpeg', 'image/png', 'image/webp']"))
    assert.ok(code.includes('5242880,   -- 5 MB per file'))
    assert.ok(code.includes("mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp'))"))
    assert.ok(code.includes('byte_size integer not null check (byte_size > 0 and byte_size <= 5242880)'))
  })

  test('THERE IS ONLY ONE KIND OF IMAGE, and it is a test screenshot', () => {
    assert.ok(code.includes("kind text not null default 'test_screenshot' check (kind = 'test_screenshot')"))
    // The two kinds the earlier draft had are gone with the product they served.
    assert.equal(code.includes('project_photo'), false)
    assert.equal(code.includes('review_proof'), false)
  })
})

describe('objects cannot be orphaned, and an accident can be corrected', () => {
  // The test that stood here asserted 'an ADMIN can withdraw a screenshot at
  // any status'. It was the admin bypass written down as a requirement: it let
  // an administrator withdraw evidence from a test somebody else ran, after a
  // verifier had already acted on it. What replaces it states the rule and the
  // price of the rule.
  test('NOBODY WITHDRAWS A SCREENSHOT FROM A CARD THEY DO NOT HOLD', () => {
    const body = byName('begin_customer_review_test_screenshot_removal').body
    assert.ok(body.includes('c.booked_by = p_actor_id'))
    assert.equal(body.includes('v_admin'), false)
    assert.equal(body.includes("'admin'"), false)
  })

  test('and the correction route for a mistaken upload is a RETURN', () => {
    // Not a lost capability, a relocated one: a verifier returns the card, the
    // status goes back to booked, and the tester withdraws their own image.
    const body = byName('transition_customer_review_test_card').body
    assert.ok(body.includes("if p_next_status in ('verified', 'booked') then"))
    const removal = byName('begin_customer_review_test_screenshot_removal').body
    assert.ok(removal.includes("if c.status <> 'booked' then"),
      'a returned card does not reopen removal')
  })

  test('a tester can only withdraw one while they still hold the card', () => {
    // Evidence a verifier has already acted on must not vanish from underneath
    // their decision.
    const body = byName('begin_customer_review_test_screenshot_removal').body
    assert.ok(body.includes("c.status <> 'booked'"))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_LOCKED'))
  })

  test('removal is marked before it is done, and is idempotent', () => {
    const begin = byName('begin_customer_review_test_screenshot_removal').body
    assert.ok(begin.includes('if s.removal_started_at is null then'))
    assert.ok(begin.includes('for update'))
    const finish = byName('finish_customer_review_test_screenshot_removal').body
    assert.ok(finish.includes('if not found then return true; end if;'),
      'a retry after a completed removal must converge rather than fail')
  })

  test('every removal is recorded in the append-only trail', () => {
    const fn = byName('customer_review_test_screenshots_log_removal').body
    assert.ok(fn.includes("'screenshot_removed'"))
    assert.ok(code.includes('before delete on public.customer_review_test_card_screenshots'))
    // And the trail row is skipped when the parent is going away, so a cascade
    // cannot write a row that is about to be deleted underneath it.
    assert.ok(fn.includes('if not exists (select 1 from public.customer_review_test_cards'))
  })
})

describe('the trail cannot be written or erased by a client', () => {
  test('no write policy exists on it', () => {
    const policies = [...code.matchAll(/create policy "([^"]+)" on public\.customer_review_test_card_events\s+for (\w+)/g)]
    assert.deepEqual(policies.map(p => p[2]), ['select'])
  })

  test('and no write grant either, TRUNCATE included', () => {
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate\n  on public.customer_review_test_card_events from authenticated, anon',
    ))
  })

  test('rows arrive only from functions the client cannot forge', () => {
    const writers = FUNCTIONS.filter(f => f.body.includes('insert into public.customer_review_test_card_events'))
    assert.ok(writers.length >= 4)
    for (const fn of writers) {
      assert.ok(
        CLIENT_CALLABLE.includes(fn.name) || INTERNAL_ONLY.includes(fn.name) || SERVICE_ROLE_ONLY.includes(fn.name),
        `${fn.name} writes the trail but is in no list`,
      )
    }
  })

  test('the trail records who did what, and when, for every step', () => {
    // The requirement in one place: who booked, opened, confirmed, submitted
    // and verified, with timestamps.
    for (const event of ['booked', 'whatsapp_opened', 'sent_confirmed', 'submitted', 'verified', 'returned']) {
      assert.ok(code.includes(`'${event}'`), `the trail has no ${event} event`)
    }
    assert.ok(code.includes('actor_id uuid not null references public.users(id)'))
    assert.ok(code.includes('created_at timestamptz not null default now()'))
  })
})
