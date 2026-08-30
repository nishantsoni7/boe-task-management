/**
 * THE ENGINE IS THE ONLY SOURCE OF AUTHORITY IN THIS MODULE.
 *
 * A single place that answers one question about the whole module: can an
 * administrator get anything here that their RESOLVED permissions do not give
 * them? The answer has to be no, everywhere, and "everywhere" is the reason
 * this file exists rather than another handful of tests spread across the six
 * files that already cover their own surfaces.
 *
 * WHAT WENT WRONG, so the next reader knows what these guard against. Every
 * layer had its own administrator shortcut, and each looked locally harmless:
 *
 *   the WhatsApp route   `if (!isAdmin) { …resolve… }` — an admin was admitted
 *                        without the engine being asked at all
 *   the photo route      the same, in BOTH handlers
 *   the module layout    `profile.role === 'admin' ||` leading the entry
 *                        disjunction, so it short-circuited
 *   the card screen      `canWorkOnIt || !!isAdmin` on screenshot removal, and
 *                        `caps.canVerify || isAdmin` on the verifier panel
 *   three SQL predicates `u.role = 'admin'` as a disjunct in each
 *
 * Individually each was "admins can do everything anyway". Together they meant
 * an explicit revocation in Control Center changed almost nothing: the person
 * still entered the module, still read every card, still saw verifier facts and
 * still got as far as a definer function before anything refused them — and
 * some of those definer functions had no administrator branch, so the refusal
 * came as a 42501 from a control the UI should never have drawn.
 *
 * THESE TESTS ARE ABOUT ABSENCE, which is the hard thing to assert. Matching a
 * corrected line proves the correction was made once; these sweep for the
 * SHAPE of the defect across every file the module owns, so it cannot come back
 * in a place nobody thought to add a test for.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveCustomerReviewCapabilities,
  holdsThisCard,
} from '@/lib/permissions/customerReviewOutreach'
import { availableActions, canBookCard } from '@/lib/customerReviews/status'
import type { EffectivePermission } from '@/lib/permissions/types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** Executable lines only. A comment explaining a removed branch is not a branch. */
const executable = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => {
      const t = line.trimStart()
      return !t.startsWith('//') && !t.startsWith('--') && !t.startsWith('*')
    })
    .join('\n')

const allow = (...keys: string[]): EffectivePermission[] =>
  keys.map(actionKey => ({ actionKey, allowed: true, source: 'role' }))

const deny = (...keys: string[]): EffectivePermission[] =>
  keys.map(actionKey => ({ actionKey, allowed: false, source: 'employee_override' }))

const HOLDER = 'user-holder'
const ADMIN = 'user-admin'

// Every file in the module that could express an authorization decision.
const APP_FILES = [
  'src/app/api/customer-reviews/whatsapp/route.ts',
  'src/app/api/customer-reviews/photos/route.ts',
  'src/app/customer-reviews/layout.tsx',
  'src/app/customer-reviews/page.tsx',
  'src/app/customer-reviews/TestCardListScreen.tsx',
  'src/app/customer-reviews/[id]/page.tsx',
  'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
  'src/components/layout/CustomerReviewsLayout.tsx',
  'src/components/customerReviews/WhatsAppLaunch.tsx',
  'src/components/customerReviews/ScreenshotManager.tsx',
  'src/components/customerReviews/ReviewPieces.tsx',
  'src/hooks/useCustomerReviews.ts',
  'src/lib/permissions/customerReviewOutreach.ts',
  'src/lib/customerReviews/status.ts',
]

const MIGRATION = 'supabase/migrations/20261017000000_customer_review_outreach.sql'

// ══ 1. AN ORDINARY ADMINISTRATOR KEEPS EVERYTHING ═══════════════════════════
//
// Stated first and deliberately, because every other test here takes something
// away. If this one ever fails the correction has overshot: the point was never
// to reduce what an administrator can do, only to route it through the engine.

describe('an admin with the seed’s normal grants keeps the full intended access', () => {
  // What the role_permissions seed actually gives them — see the migration's
  // ROLE DEFAULTS block, which grants `admin` every action this module has.
  const caps = deriveCustomerReviewCapabilities('admin', allow('use', 'verify'))

  test('they hold both capabilities and may open the module', () => {
    assert.deepEqual(caps, { canAccessModule: true, canUse: true, canVerify: true })
  })

  test('they may book an available card', () => {
    assert.equal(canBookCard({ status: 'available' }, { userId: ADMIN, canUse: caps.canUse }), true)
  })

  test('they may run a card they booked themselves, end to end', () => {
    assert.equal(holdsThisCard({ booked_by: ADMIN }, ADMIN, caps), true)
    assert.deepEqual(
      availableActions({ status: 'booked', booked_by: ADMIN },
        { userId: ADMIN, canUse: caps.canUse, canVerify: caps.canVerify }).map(a => a.to),
      ['submitted'],
    )
  })

  test('and they may verify and return somebody else’s submitted card', () => {
    assert.deepEqual(
      availableActions({ status: 'submitted', booked_by: HOLDER },
        { userId: ADMIN, canUse: caps.canUse, canVerify: caps.canVerify }).map(a => a.to).sort(),
      ['booked', 'verified'],
    )
  })

  test('THE SEED IS WHAT GRANTS THEM THAT, and it is still in the migration', () => {
    // The whole argument for removing the shortcuts rests on this row existing.
    // If the seed were ever dropped, the corrections above would stop being
    // "route it through the engine" and start being "lock administrators out".
    const sql = read(MIGRATION)
    const seed = sql.slice(sql.indexOf('ROLE DEFAULTS'))
    assert.ok(seed.includes("select 'admin', mpa.module_id, mpa.action_id, true"),
      'the admin role seed is gone; administrators would now hold nothing')
  })
})

// ══ 2. AN ADMIN WITH `use` REVOKED IS NOT A TESTER ══════════════════════════

describe('an admin whose `use` is revoked cannot act as a candidate', () => {
  const caps = deriveCustomerReviewCapabilities('admin', [
    ...deny('use'),
    ...allow('verify'),
  ])

  test('precondition: this is an admin who genuinely lost `use` and kept `verify`', () => {
    assert.equal(caps.canUse, false)
    assert.equal(caps.canVerify, true)
  })

  test('they cannot BOOK', () => {
    assert.equal(canBookCard({ status: 'available' }, { userId: ADMIN, canUse: caps.canUse }), false)
  })

  test('they cannot PREPARE WHATSAPP, UPLOAD, REMOVE or CONFIRM — all four are `mine`', () => {
    // The detail screen draws every one of those from holdsThisCard(). Asserted
    // on a card booked in the admin's OWN name, which is the strong case: it
    // cannot be explained away as the card belonging to somebody else.
    assert.equal(holdsThisCard({ booked_by: ADMIN }, ADMIN, caps), false)
  })

  test('they cannot SUBMIT', () => {
    assert.deepEqual(
      availableActions({ status: 'booked', booked_by: ADMIN },
        { userId: ADMIN, canUse: caps.canUse, canVerify: caps.canVerify }),
      [],
    )
  })

  test('but they keep verification, because only ONE authority was revoked', () => {
    assert.deepEqual(
      availableActions({ status: 'submitted', booked_by: HOLDER },
        { userId: ADMIN, canUse: caps.canUse, canVerify: caps.canVerify }).map(a => a.to).sort(),
      ['booked', 'verified'],
    )
    assert.equal(caps.canAccessModule, true, 'a verifier must still be able to open the module')
  })
})

// ══ 3. AN ADMIN WITH `verify` REVOKED IS NOT A VERIFIER ═════════════════════

describe('an admin whose `verify` is revoked sees no verifier control or row', () => {
  const caps = deriveCustomerReviewCapabilities('admin', [
    ...allow('use'),
    ...deny('verify'),
  ])

  test('precondition: they kept `use` and lost `verify`', () => {
    assert.equal(caps.canUse, true)
    assert.equal(caps.canVerify, false)
  })

  test('neither Verify test nor Return to tester is offered', () => {
    assert.deepEqual(
      availableActions({ status: 'submitted', booked_by: HOLDER },
        { userId: ADMIN, canUse: caps.canUse, canVerify: caps.canVerify }),
      [],
    )
  })

  test('THE VERIFIER FACTS PANEL IS GATED ON caps.canVerify ALONE', () => {
    // It used to read `(caps.canVerify || isAdmin)`, which showed the timeline
    // of somebody else's test to an administrator the transition function will
    // not let act on it.
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    assert.ok(executable(detail).includes('{caps.canVerify && card.status !== \'available\' && ('))
  })

  test('and the verifier-only TAB is gated on caps.canVerify alone', () => {
    const list = read('src/app/customer-reviews/TestCardListScreen.tsx')
    assert.ok(executable(list).includes('if (caps.canVerify) {'))
  })

  test('THE DATABASE AGREES: no row predicate admits them by role', () => {
    // The UI half above would be worthless if RLS still handed the rows over.
    const sql = read(MIGRATION)
    const rowFn = /create or replace function public\.can_view_customer_review_test_card_row[\s\S]*?\$\$;/
      .exec(sql)?.[0] ?? ''
    assert.ok(rowFn, 'the row predicate is missing')
    assert.equal(/role/.test(executable(rowFn)), false)
    assert.ok(rowFn.includes("resolve_permission(auth.uid(), 'customer_review_requests', 'verify')"))
  })
})

// ══ 4. AN ADMIN WITH BOTH REVOKED CANNOT ENTER OR READ ══════════════════════

describe('an admin with both permissions revoked is outside the module', () => {
  const caps = deriveCustomerReviewCapabilities('admin', deny('use', 'verify'))

  test('they hold nothing, so the launcher card and the route guard both refuse', () => {
    assert.deepEqual(caps, { canAccessModule: false, canUse: false, canVerify: false })
  })

  test('THE LAYOUT GATE IS RESOLVED-ONLY, and no longer led by a role', () => {
    // `profile.role === 'admin' ||` used to come first in this disjunction, so
    // it short-circuited before either permission was consulted.
    const layout = executable(read('src/app/customer-reviews/layout.tsx'))
    assert.equal(/role/.test(layout), false, 'the entry gate still reads a role')
    assert.ok(layout.includes("'customer_review_requests', 'use'"))
    assert.ok(layout.includes("'customer_review_requests', 'verify'"))
    // A permission question that could not be answered is not a yes.
    assert.equal((layout.match(/catch\(\(\) => false\)/g) ?? []).length, 2)
  })

  test('AND THE DATABASE ENTRY PREDICATE AGREES', () => {
    const sql = read(MIGRATION)
    const fn = /create or replace function public\.can_use_customer_review_test_cards\(\)[\s\S]*?\$\$;/
      .exec(sql)?.[0] ?? ''
    assert.ok(fn, 'the pool predicate is missing')
    assert.equal(/role/.test(executable(fn)), false)
    assert.ok(fn.includes("'use'") && fn.includes("'verify'"))
  })

  test('so every list is empty by RLS, not merely hidden by the screen', () => {
    // The card predicate is the one that decides a single row. With neither
    // permission there is no branch left to match: not holder (they hold
    // nothing), not verify, and not the available-pool branch, which requires
    // `use`.
    const sql = read(MIGRATION)
    const fn = /create or replace function public\.can_view_customer_review_test_card\(\n?[\s\S]*?\$\$;/
      .exec(sql)?.[0] ?? ''
    assert.ok(fn, 'the card predicate is missing')
    const body = executable(fn)
    assert.equal(/role/.test(body), false)
    assert.ok(body.includes('c.booked_by = auth.uid()'))
    assert.ok(body.includes("c.status = 'available'"))
  })
})

// ══ 5. THE ORDINARY PEOPLE STILL COMPLETE THEIR WORKFLOWS ═══════════════════
//
// The control case. Every test above removes something from an administrator;
// these prove the module still works for the two people it is actually for.

describe('a tester and a verifier with valid permissions still work', () => {
  const tester = deriveCustomerReviewCapabilities('member', allow('use'))
  const verifier = deriveCustomerReviewCapabilities('member', allow('verify'))

  test('THE TESTER: book → prepare → confirm → submit', () => {
    assert.equal(tester.canAccessModule, true)
    assert.equal(canBookCard({ status: 'available' }, { userId: HOLDER, canUse: tester.canUse }), true)
    // Everything between booking and submitting is drawn from `mine`.
    assert.equal(holdsThisCard({ booked_by: HOLDER }, HOLDER, tester), true)
    assert.deepEqual(
      availableActions({ status: 'booked', booked_by: HOLDER },
        { userId: HOLDER, canUse: tester.canUse, canVerify: tester.canVerify }).map(a => a.to),
      ['submitted'],
    )
  })

  test('…and cannot verify their own test, which is the separation', () => {
    assert.deepEqual(
      availableActions({ status: 'submitted', booked_by: HOLDER },
        { userId: HOLDER, canUse: tester.canUse, canVerify: tester.canVerify }),
      [],
    )
  })

  test('THE VERIFIER: reads every card, verifies and returns', () => {
    assert.equal(verifier.canAccessModule, true)
    assert.deepEqual(
      availableActions({ status: 'submitted', booked_by: HOLDER },
        { userId: 'user-verifier', canUse: verifier.canUse, canVerify: verifier.canVerify })
        .map(a => a.to).sort(),
      ['booked', 'verified'],
    )
  })

  test('…and cannot book or act as a tester, which is the other half', () => {
    assert.equal(canBookCard({ status: 'available' }, { userId: 'user-verifier', canUse: verifier.canUse }), false)
    assert.equal(holdsThisCard({ booked_by: 'user-verifier' }, 'user-verifier', verifier), false)
  })
})

// ══ 6. THE SWEEP ════════════════════════════════════════════════════════════
//
// The tests above name the places the defect was found. This one looks for the
// places it has not been found yet.

describe('NO ROLE IS AN AUTHORIZATION ALTERNATIVE ANYWHERE IN THIS MODULE', () => {
  test('no application file names the admin role at all', () => {
    const offenders: string[] = []
    for (const file of APP_FILES) {
      const body = executable(read(file))
      if (/'admin'|"admin"|role === 'admin'|isAdmin/.test(body)) offenders.push(file)
    }
    assert.deepEqual(offenders, [],
      'these files still name the admin role in executable code')
  })

  test('no application file SELECTS users.role for this module', () => {
    // Reading the column is the step before branching on it, and it is the one
    // a diff makes visible. Both routes and the layout used to select it; none
    // does now, so a role never even arrives in those files.
    const offenders: string[] = []
    for (const file of APP_FILES) {
      if (/select\(['"]role/.test(executable(read(file)))) offenders.push(file)
    }
    assert.deepEqual(offenders, [],
      'these files still select users.role; a value that arrives can be branched on')
  })

  test('THE ONE PLACE A ROLE IS STILL PASSED, and why it is not an exception', () => {
    // useCustomerReviews hands profile.role to deriveCustomerReviewCapabilities.
    // That call is the retained first parameter, kept because rewriting both
    // call sites was out of scope for the correction that removed the last
    // branch reading it — see the @param note on the function.
    //
    // It is not an authorization alternative, and this test is what makes that
    // checkable rather than a claim: the ONLY `.role` in any of these files is
    // that one argument, and the function it is passed to is pinned by a
    // behavioural test (customerReviewOutreach.test.ts → "THE ROLE IS NOT READ
    // AT ALL") asserting that every role value yields identical capabilities.
    const uses: string[] = []
    for (const file of APP_FILES) {
      for (const line of executable(read(file)).split('\n')) {
        if (/\.role\b/.test(line)) uses.push(`${file}: ${line.trim()}`)
      }
    }
    assert.deepEqual(uses, [
      'src/hooks/useCustomerReviews.ts: setCaps(deriveCustomerReviewCapabilities(prof.role, effective))',
    ], 'a role reached somewhere new, or the known one changed shape')

    // And it decides nothing: no comparison, no branch, no ternary around it.
    const hook = executable(read('src/hooks/useCustomerReviews.ts'))
    assert.equal(/role\s*===|===\s*prof\.role|role\s*\?|if\s*\([^)]*role/.test(hook), false,
      'the hook now branches on a role')
  })

  test('NO SQL VISIBILITY PREDICATE OR DEFINER FUNCTION READS A ROLE', () => {
    // Every function this module defines, swept at once — the three visibility
    // predicates and the five definer functions that carry an action.
    const sql = read(MIGRATION)
    const offenders: string[] = []
    for (const m of sql.matchAll(/create or replace function (public\.\w+)\([\s\S]*?\$\$;/g)) {
      const body = executable(m[0])
      if (/u\.role|users\.role|'admin'/.test(body)) offenders.push(m[1])
    }
    assert.deepEqual(offenders, [],
      'these SQL functions still consult a role')
  })

  test('…and every one of them still asks the engine, so nothing was merely deleted', () => {
    // The failure mode this guards against: "remove the role check" satisfied
    // by removing the authorization entirely.
    const sql = read(MIGRATION)
    for (const name of ['can_use_customer_review_test_cards',
                        'can_view_customer_review_test_card_row',
                        'can_view_customer_review_test_card',
                        'book_customer_review_test_card',
                        'transition_customer_review_test_card',
                        'confirm_customer_review_test_card_sent',
                        'begin_customer_review_test_screenshot_removal',
                        'record_customer_review_test_card_whatsapp_opened']) {
      const fn = new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?\\$\\$;')
        .exec(sql)?.[0] ?? ''
      assert.ok(fn, name + ' is missing')
      assert.ok(
        fn.includes('public.resolve_permission('),
        name + ' no longer asks the permission engine anything',
      )
    }
  })

  test('THE ONLY PLACE THE ADMIN ROLE APPEARS IN SQL IS THE GRANT SEED', () => {
    // Which is exactly where it belongs: it is how an administrator COMES TO
    // HOLD the permissions, not a way around holding them.
    const sql = read(MIGRATION)
    const lines = executable(sql).split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(l => /'admin'/.test(l.line))
    assert.equal(lines.length, 1, 'the admin role is named more than once in executable SQL')
    assert.ok(lines[0].line.startsWith("select 'admin', mpa.module_id"),
      `unexpected use of the admin role: ${lines[0].line}`)
  })
})
