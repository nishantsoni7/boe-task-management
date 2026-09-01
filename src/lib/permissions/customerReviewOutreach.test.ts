/**
 * Review Workflow Test (Internal) — permissions, module visibility, and the
 * screens that read them.
 *
 * Two halves:
 *   1. behavioural assertions on the capability derivation;
 *   2. source-shape assertions on the guard, the launcher and the screens, so
 *      that "the UI asks the same question the database does" is proved against
 *      the real files rather than asserted in a comment.
 *
 * Repository files only. No DB, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/customerReviewOutreach.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NO_CUSTOMER_REVIEW_CAPABILITIES,
  deriveCustomerReviewCapabilities,
  holdsThisCard,
} from './customerReviewOutreach'
// The two screen-side helpers this file now exercises directly, so that "an
// admin without `use` is offered nothing" is asserted against the functions the
// screens call rather than against their source text.
import { availableActions, canBookCard } from '@/lib/customerReviews/status'
import {
  ACTION_DEPENDENCIES,
  PRESET_LEVELS,
  entryActionForModule,
  isProtectedAction,
  presetAllowedActions,
  enableModuleEntry,
  withRequiredDependencies,
  dependentActionsToRemove,
} from './levels'
import { moduleEnforcement } from './enforcement'
import { getRegisteredModule } from './registry'
import './modules'
import type { EffectivePermission } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MODULE = 'customer_review_requests'
const ACTIONS = ['use', 'verify']

const allow = (...keys: string[]): EffectivePermission[] =>
  ACTIONS.map(actionKey => ({
    actionKey,
    allowed: keys.includes(actionKey),
    source: 'employee_override' as const,
  }))

// ── 1. The registry ─────────────────────────────────────────────────────────

describe('what the module registers', () => {
  test('exactly two actions, and neither is `view`', () => {
    const mod = getRegisteredModule(MODULE)
    assert.ok(mod, 'the module is not registered')
    assert.deepEqual(mod!.actions.map(a => a.actionKey).sort(), ['use', 'verify'])
    // The KEY is unchanged — every existing Control Center grant is written
    // against it — and the display name is not, because that is the part a
    // human reads and this module is no longer customer outreach.
    assert.equal(mod!.displayName, 'Review Workflow')
    // No user-facing name may still say Test — the module is not a test any more.
    assert.equal(/test/i.test(mod!.displayName), false)
  })

  test('`use` is the module’s entry action', () => {
    assert.equal(entryActionForModule(ACTIONS), 'use')
    // And `view` still wins wherever a module registers it, so nothing else moved.
    assert.equal(entryActionForModule(['view', 'create', 'edit']), 'view')
    assert.equal(entryActionForModule(['view', 'use']), 'view')
    assert.equal(entryActionForModule(['export']), null)
  })

  test('turning the module on grants `use`, not nothing', () => {
    // Before entryActionForModule existed this returned an unchanged map, so
    // the switch in Control Center was a control that decided nothing.
    const next = enableModuleEntry(ACTIONS, { use: false, verify: false })
    assert.equal(next.use, true)
    assert.equal(next.verify, false)
  })

  test('turning it on never disturbs a verify grant somebody already holds', () => {
    const next = enableModuleEntry(ACTIONS, { use: false, verify: true })
    assert.deepEqual(next, { use: true, verify: true })
  })

  test('`verify` is PROTECTED and `use` is not', () => {
    assert.equal(isProtectedAction('verify'), true)
    assert.equal(isProtectedAction('use'), false)
  })

  test('NO PRESET EVER GRANTS verify', () => {
    // This is the safeguard: the employee who ran the outreach must not acquire
    // sign-off authority by somebody picking "Manager" from a dropdown.
    for (const level of PRESET_LEVELS) {
      assert.equal(presetAllowedActions(level, ACTIONS).verify, false, level)
    }
  })

  test('verify depends on use, so a verifier can always open the module', () => {
    assert.equal(ACTION_DEPENDENCIES.verify, 'use')
    assert.deepEqual(withRequiredDependencies(['verify'], ACTIONS), ['use', 'verify'])
  })

  test('withdrawing use takes verify with it', () => {
    // Otherwise an administrator would believe they had removed the module
    // while the stronger grant survived.
    assert.deepEqual(dependentActionsToRemove('use', ACTIONS), ['verify'])
  })

  test('the enforcement claim says both actions are live', () => {
    const claim = moduleEnforcement(MODULE)
    assert.equal(claim.state, 'enforced')
  })
})

// ── 2. Capabilities ─────────────────────────────────────────────────────────

describe('deriving capabilities', () => {
  test('no grants means no access at all', () => {
    assert.deepEqual(
      deriveCustomerReviewCapabilities('member', allow()),
      NO_CUSTOMER_REVIEW_CAPABILITIES,
    )
    assert.deepEqual(
      deriveCustomerReviewCapabilities(null, []),
      NO_CUSTOMER_REVIEW_CAPABILITIES,
    )
  })

  test('`use` opens the module and grants no verification', () => {
    const caps = deriveCustomerReviewCapabilities('member', allow('use'))
    assert.deepEqual(caps, { canAccessModule: true, canUse: true, canVerify: false })
  })

  test('`verify` alone opens the module and grants no outreach', () => {
    // A verifier who could not open the module could not verify anything, so
    // entry is implied. Raising a request is not.
    const caps = deriveCustomerReviewCapabilities('member', allow('verify'))
    assert.deepEqual(caps, { canAccessModule: true, canUse: false, canVerify: true })
  })

  // ── THE ADMIN SHORT-CIRCUIT FOR `use` IS GONE ──────────────────────────
  //
  // The test that stood here read 'an admin holds everything without a single
  // grant row' and expected canUse: true from the role alone. That is what drew
  // an administrator a Book button the database would refuse: booking asks
  // resolve_permission(uid, …, 'use') and has no administrator branch.
  //
  // The three below replace it. They are separate tests because they fail for
  // different reasons and a reader should be able to tell which broke.
  test('AN ADMINISTRATOR WITH NO RESOLVED GRANT IS NOT A CANDIDATE', () => {
    const caps = deriveCustomerReviewCapabilities('admin', [])
    assert.equal(caps.canUse, false, 'the role alone still confers candidate authority')
  })

  test('…AND VERIFIER AUTHORITY IS THE RESOLVED PERMISSION TOO', () => {
    // The last bypass. An administrator with no grant rows at all now holds
    // nothing here, because transition_customer_review_test_card() resolves
    // 'verify' and has no administrator branch either — so Verify test and
    // Return to tester would have been drawn and then refused 42501.
    const caps = deriveCustomerReviewCapabilities('admin', [])
    assert.equal(caps.canVerify, false)
    assert.equal(caps.canAccessModule, false, 'the module opens for somebody who can do nothing in it')
  })

  test('AN ADMINISTRATOR WHOSE use IS REVOKED IS NOT A CANDIDATE EITHER', () => {
    // The case the bypass actually broke. An explicit employee override is the
    // highest level in the engine, so revoking one individual administrator is
    // expressible — and until now the screen ignored it.
    const revoked: EffectivePermission[] = [
      { actionKey: 'use', allowed: false, source: 'employee_override' },
      { actionKey: 'verify', allowed: true, source: 'role' },
    ]
    const caps = deriveCustomerReviewCapabilities('admin', revoked)
    assert.equal(caps.canUse, false)
    assert.equal(caps.canVerify, true, 'revoking one action must not touch the other')
  })

  test('THE ROLE IS NOT READ AT ALL — same permissions, same answer, any role', () => {
    // Stronger than asserting the two branches are gone, and it is the test
    // that keeps them gone: if a future edit reintroduces a role check of any
    // shape, two of these rows stop matching.
    //
    // `role` is still in the signature because both call sites pass
    // profile.role positionally and rewriting them was not part of this
    // correction. This is what makes that safe.
    const cases: (string | null | undefined)[] = ['admin', 'manager', 'member', 'owner', '', null, undefined]
    for (const permissions of [[], allow('use'), allow('verify'), allow('use', 'verify')]) {
      const expected = deriveCustomerReviewCapabilities('member', permissions)
      for (const role of cases) {
        assert.deepEqual(
          deriveCustomerReviewCapabilities(role, permissions), expected,
          `role ${String(role)} changed the answer for [${permissions.map(p => p.actionKey).join(',')}]`,
        )
      }
    }
  })

  test('an administrator WITH the resolved grant is a candidate, like anyone', () => {
    // The rule is "the resolved permission decides", not "administrators are
    // excluded". The seed grants admin `use`, so this is the ordinary case.
    assert.equal(deriveCustomerReviewCapabilities('admin', allow('use')).canUse, true)
  })

  // ══ VERIFY AND RETURN, FOR THE FOUR PEOPLE WHO MATTER ═══════════════════
  //
  // Asserted on the controls a screen would draw rather than on the capability
  // flag, because "sees Verify and Return" is the claim being made. Both are
  // verifier-only transitions off a SUBMITTED card, and the viewer never holds
  // it — a verifier acting on somebody else's evidence is the whole point.
  describe('who is offered Verify review and Return to candidate', () => {
    const SUBMITTED = { status: 'submitted' as const, booked_by: 'user-holder', deleted_at: null }
    const VIEWER = 'user-viewer'

    const offered = (caps: ReturnType<typeof deriveCustomerReviewCapabilities>) =>
      availableActions(SUBMITTED, {
        userId: VIEWER, canUse: caps.canUse, canVerify: caps.canVerify,
      }).map(a => a.label).sort()

    test('1. an ADMIN WITH resolved verify sees Verify and Return', () => {
      // The ordinary administrator: the role_permissions seed grants both, so
      // the engine resolves them and nothing they had is lost.
      const caps = deriveCustomerReviewCapabilities('admin', allow('use', 'verify'))
      assert.equal(caps.canVerify, true)
      assert.deepEqual(offered(caps), ['Return to candidate', 'Verify review'])
    })

    test('2. an ADMIN whose verify is REVOKED sees NEITHER', () => {
      // The correction. transition_customer_review_test_card() resolves
      // 'verify' with no administrator branch, so it would refuse both 42501 —
      // and a button that is always refused is worse than no button.
      const revoked: EffectivePermission[] = [
        { actionKey: 'use', allowed: true, source: 'role' },
        { actionKey: 'verify', allowed: false, source: 'employee_override' },
      ]
      const caps = deriveCustomerReviewCapabilities('admin', revoked)
      assert.equal(caps.canVerify, false)
      assert.deepEqual(offered(caps), [])

      // …and `use` is untouched, so this is a change to ONE authority rather
      // than an administrator losing the module.
      assert.equal(caps.canUse, true)
    })

    test('3. a NON-ADMIN verifier with resolved verify still sees both', () => {
      // The case that proves the rule is about the permission and not about
      // punishing administrators. This person holds `verify` and NOT `use`,
      // which is the separation the workflow exists to exercise.
      const caps = deriveCustomerReviewCapabilities('member', allow('verify'))
      assert.equal(caps.canVerify, true)
      assert.equal(caps.canUse, false)
      assert.deepEqual(offered(caps), ['Return to candidate', 'Verify review'])
    })

    test('4. NO TESTER OWNERSHIP OR DATABASE RULE MOVED', () => {
      // This correction is one boolean on one screen-side derivation. Nothing
      // about who OWNS a card, and nothing in SQL, may have shifted with it.

      // (a) Ownership is still holder-only, and still ignores the role.
      const adminCaps = deriveCustomerReviewCapabilities('admin', allow('use', 'verify'))
      assert.equal(holdsThisCard({ booked_by: 'user-holder' }, VIEWER, adminCaps), false)
      assert.equal(holdsThisCard({ booked_by: VIEWER }, VIEWER, adminCaps), true)
      assert.equal(holdsThisCard.length, 3, 'holdsThisCard grew a parameter')

      // (b) A verifier is still offered no CANDIDATE action, on any card —
      // verify authority has never implied tester authority and still does not.
      const verifierOnly = deriveCustomerReviewCapabilities('member', allow('verify'))
      assert.deepEqual(
        availableActions({ status: 'booked', booked_by: VIEWER, deleted_at: null },
          { userId: VIEWER, canUse: verifierOnly.canUse, canVerify: verifierOnly.canVerify }),
        [],
        'a verifier can submit a card they hold',
      )
      assert.equal(canBookCard({ status: 'available', deleted_at: null }, { userId: VIEWER, canUse: verifierOnly.canUse }), false)

      // (c) THE DATABASE IS UNTOUCHED. Read off the migration: the two definer
      // functions that gate these moves still resolve their permission and
      // still carry no administrator branch, and the ownership half of the
      // submit gate is still there. If this correction had leaked into SQL,
      // this is where it would show.
      const sql = read('supabase/migrations/20261017000000_customer_review_outreach.sql')
      const fn = sql.slice(
        sql.indexOf('create or replace function public.transition_customer_review_test_card'),
      )
      const body = fn.slice(0, fn.indexOf('$$;') + 3)
      assert.ok(body.includes("v_verify := public.resolve_permission(v_uid, 'customer_review_requests', 'verify');"))
      assert.ok(body.includes('if not v_verify then'))
      assert.ok(body.includes('if not (v_holder and v_use) then'), 'the submit gate lost its ownership half')
      assert.equal(body.includes('v_admin'), false, 'an administrator branch appeared in SQL')
      assert.equal(body.includes("'admin'"), false, 'the transition consults a role')
    })
  })

  test('a manager gets nothing from their role alone', () => {
    // The migration grants role defaults to `admin` only: who runs outreach and
    // who signs it off are per-person decisions.
    assert.deepEqual(
      deriveCustomerReviewCapabilities('manager', allow()),
      NO_CUSTOMER_REVIEW_CAPABILITIES,
    )
  })

  test('an explicitly DENIED action is not silently treated as allowed', () => {
    const denied: EffectivePermission[] = [
      { actionKey: 'use', allowed: false, source: 'employee_override' },
      { actionKey: 'verify', allowed: false, source: 'role' },
    ]
    assert.deepEqual(deriveCustomerReviewCapabilities('member', denied), NO_CUSTOMER_REVIEW_CAPABILITIES)
  })

  test('an unrelated module’s grants confer nothing here', () => {
    const other: EffectivePermission[] = [
      { actionKey: 'manage', allowed: true, source: 'role' },
      { actionKey: 'view', allowed: true, source: 'role' },
    ]
    assert.deepEqual(deriveCustomerReviewCapabilities('member', other), NO_CUSTOMER_REVIEW_CAPABILITIES)
  })
})

describe('who holds one test card', () => {
  const HOLDER = 'user-holder'
  const OTHER = 'user-other'
  const useCaps = deriveCustomerReviewCapabilities('member', allow('use'))
  const verifyCaps = deriveCustomerReviewCapabilities('member', allow('verify'))
  // An administrator in the ORDINARY case: the role_permissions seed grants
  // them `use`, so the engine resolves it and they are a candidate like anyone
  // else. The no-grant case is `bare` further down, and it is a different
  // person for a different reason.
  const adminCaps = deriveCustomerReviewCapabilities('admin', allow('use', 'verify'))

  // THERE IS NO EDITORSHIP QUESTION IN THIS MODULE, and that is why the block
  // that used to be here is gone rather than adapted. Card text is loaded from
  // a fixture and no client role holds INSERT or UPDATE on the table at all, so
  // "may I change this" has one answer for everybody and it is no. The only
  // question a screen has is "is this mine to act on".

  test('the tester holding the card may act on it', () => {
    assert.equal(holdsThisCard({ booked_by: HOLDER }, HOLDER, useCaps), true)
  })

  test('a VERIFIER does not run somebody else’s test for them', () => {
    assert.equal(holdsThisCard({ booked_by: HOLDER }, OTHER, verifyCaps), false)
  })

  test('another `use` holder cannot act on a card that is not theirs', () => {
    assert.equal(holdsThisCard({ booked_by: HOLDER }, OTHER, useCaps), false)
  })

  // THE ADMIN BYPASS IS GONE, and this test replaces the one that asserted it.
  //
  // The removed test read 'an admin may unstick a card whose tester has left'.
  // It described a real problem and the wrong remedy: it let an administrator
  // open WhatsApp as somebody else, confirm a send they did not make, and
  // submit evidence they did not produce. Unsticking a card is a verifier
  // RETURNING it, which puts it back in the tester's hands rather than putting
  // the tester's actions in somebody else's.
  test('an administrator does not hold a card they did not book', () => {
    assert.equal(adminCaps.canUse, true, 'the admin genuinely has use')
    assert.equal(holdsThisCard({ booked_by: HOLDER }, OTHER, adminCaps), false)
  })

  test('an administrator holds a card they booked themselves, like anyone', () => {
    assert.equal(holdsThisCard({ booked_by: OTHER }, OTHER, adminCaps), true)
  })

  // ── AN ADMINISTRATOR WITHOUT `use` IS OFFERED NO CANDIDATE ACTION ────────
  //
  // The two corrections meet here. Ownership already stopped an administrator
  // acting on somebody ELSE'S card; this is the other half — an administrator
  // with no resolved `use` is not a candidate on ANY card, including one
  // booked in their own name.
  //
  // Every candidate action is checked, not just Book, because they are drawn
  // from three different places: canBookCard on the list, holdsThisCard for the
  // WhatsApp / screenshot / confirm panel, and availableActions for Submit.
  test('AN ADMIN WITHOUT use IS OFFERED NO BOOK, WHATSAPP, UPLOAD, CONFIRM OR SUBMIT', () => {
    // An administrator whose `use` is revoked and whose `verify` is intact.
    // Chosen so the tail of this test — that verifier moves are untouched —
    // still says something: with no grants at all they would now hold nothing,
    // and "offered nothing" would pass for the wrong reason.
    const bare = deriveCustomerReviewCapabilities('admin', [
      { actionKey: 'use', allowed: false, source: 'employee_override' },
      { actionKey: 'verify', allowed: true, source: 'role' },
    ])
    assert.equal(bare.canUse, false, 'precondition: this admin has no resolved use')
    assert.equal(bare.canVerify, true, 'precondition: their verify is intact')

    // BOOK — the list's button, on an unbooked card.
    assert.equal(canBookCard({ status: 'available', deleted_at: null }, { userId: OTHER, canUse: bare.canUse }), false)

    // WHATSAPP, SCREENSHOT UPLOAD, SCREENSHOT REMOVAL and CONFIRM SENT are all
    // drawn from `mine` on the detail screen, which is holdsThisCard(). False
    // for a card they hold in their own name is the strong case: it cannot be
    // explained away by the card belonging to somebody else.
    assert.equal(holdsThisCard({ booked_by: OTHER }, OTHER, bare), false,
      'an admin without use is offered candidate controls on their own card')

    // SUBMIT — the only candidate transition.
    assert.deepEqual(
      availableActions({ status: 'booked', booked_by: OTHER, deleted_at: null },
        { userId: OTHER, canUse: bare.canUse, canVerify: bare.canVerify }),
      [],
      'Submit is offered to an admin who is not a candidate',
    )

    // …and the verifier moves they SHOULD still be offered are untouched, so
    // this test cannot pass by refusing everybody.
    assert.deepEqual(
      availableActions({ status: 'submitted', booked_by: HOLDER, deleted_at: null },
        { userId: OTHER, canUse: bare.canUse, canVerify: bare.canVerify })
        .map(a => a.to).sort(),
      ['booked', 'verified'],
    )
  })

  // The signature no longer accepts a role, so a caller cannot pass one and
  // believe it counts for something. Checked structurally, because an extra
  // argument to a JS function is silently ignored rather than a type error at
  // every call site.
  test('the function takes no role parameter at all', () => {
    assert.equal(holdsThisCard.length, 3, 'card, userId, caps — and nothing else')

    const src = read('src/lib/permissions/customerReviewOutreach.ts')
    const body = src.slice(src.indexOf('export function holdsThisCard'))
    assert.equal(/role/.test(body), false, 'holdsThisCard still mentions a role')
  })

  test('an unbooked card is nobody’s to act on', () => {
    assert.equal(holdsThisCard({ booked_by: null }, HOLDER, useCaps), false)
  })

  test('a signed-out caller acts on nothing', () => {
    assert.equal(holdsThisCard({ booked_by: HOLDER }, null, useCaps), false)
  })
})

// ── 3. The screens ──────────────────────────────────────────────────────────

describe('the route guard', () => {
  const guard = read('src/app/customer-reviews/layout.tsx')

  test('every screen in the module is behind it', () => {
    // A layout.tsx at the module root wraps /customer-reviews and
    // /customer-reviews/[id] alike, so there is no route that can mount
    // unguarded. (The /new and /[id]/edit routes are gone with the authoring
    // workflow they served — nothing here is created or edited by a browser.)
    assert.ok(guard.includes('export default function CustomerReviewsGuard'))
  })

  test('it resolves the module’s own two actions, never `view`', () => {
    assert.ok(guard.includes("hasPermission(supabase, session.user.id, 'customer_review_requests', 'use')"))
    assert.ok(guard.includes("hasPermission(supabase, session.user.id, 'customer_review_requests', 'verify')"))
    assert.equal(guard.includes("'view'"), false)
  })

  test('it fails closed on a missing profile, an inactive account and a signed-out caller', () => {
    assert.ok(guard.includes("if (!session) { router.replace('/login'); return }"))
    assert.ok(guard.includes('if (!profile || profile.is_active !== true)'))
    assert.ok(guard.includes(".catch(() => false)"))
  })

  test('children never render before the check finishes', () => {
    assert.ok(guard.includes('if (!authorized) return <LoadingScreen />'))
  })
})

describe('the launcher card', () => {
  const launcher = read('src/app/modules/page.tsx')

  test('it resolves the module through its own capability derivation', () => {
    // canAccessManagementModule asks strictly for `view`; asking it here would
    // hide the card from everybody who actually holds the module.
    assert.ok(launcher.includes('deriveCustomerReviewCapabilities('))
    assert.ok(launcher.includes("permsByModule.get('customer_review_requests')"))
    assert.ok(launcher.includes('.canAccessModule'))
  })

  test('the card is conditional on that answer and on nothing else', () => {
    assert.ok(launcher.includes('...(canOpenCustomerReviews ? [{'))
    assert.ok(launcher.includes("href: '/customer-reviews',"))
  })

  test('it reads the SIGNED-IN role, so View As lends no authority', () => {
    const block = launcher.slice(
      launcher.indexOf('const canOpenCustomerReviews'),
      launcher.indexOf('.canAccessModule'),
    )
    assert.ok(block.includes('signedInRole'))
    assert.equal(block.includes('effectiveProfile'), false)
  })
})

describe('Control Center', () => {
  const page = read('src/app/admin/control-center/permissions/page.tsx')

  test('the module switch follows the module’s own entry action', () => {
    assert.ok(page.includes('function entryActionFor(mod: ModuleState)'))
    assert.ok(page.includes('entryActionForModule(mod.actions.map(a => a.actionKey)) ?? MODULE_ENTRY_ACTION'))
    assert.ok(page.includes('effectiveMapForModule(mod, overrides)[entryActionFor(mod)] === true'))
  })

  test('`view` is still the default for every other module', () => {
    assert.ok(page.includes("const MODULE_ENTRY_ACTION = 'view'"))
  })

  test('withdrawing verify is named in plain words in the confirmation', () => {
    assert.ok(page.includes("verify:                'Verify and close customer review requests',"))
  })
})

describe('the screens ask the database, and offer nothing it would refuse', () => {
  const list = read('src/app/customer-reviews/TestCardListScreen.tsx')
  const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')

  test('every status action comes from availableActions, never from an inline test', () => {
    assert.ok(detail.includes('availableActions(card, {'))
    assert.ok(detail.includes('canVerify: caps.canVerify,'))
    // No hand-rolled status branching deciding what to offer.
    assert.equal(/status === 'verified' &&/.test(detail), false)
  })

  test('every status change goes through the one RPC', () => {
    assert.ok(detail.includes("supabase.rpc('transition_customer_review_test_card'"))
    // Nothing writes a status column directly — and it could not: no client
    // role holds UPDATE on the card table at all.
    assert.equal(/\.update\(\{[^}]*status:/.test(detail), false)
    assert.equal(/\.update\(\{[^}]*status:/.test(list), false)
  })

  test('BOOKING goes through its own RPC, not through the transition', () => {
    // Booking must be a single conditional UPDATE to win a race between two
    // testers; routing it through the generic transition would lock a row it
    // had already read, one step too late.
    assert.ok(list.includes("supabase.rpc('book_customer_review_test_card'"))
    assert.equal(list.includes('transition_customer_review_test_card'), false)
  })

  test('the Book button is drawn from canBookCard, and from nothing else', () => {
    // It moved off the card and into the full-review sheet — a candidate reads
    // the whole thing before taking it — but the predicate behind it did not
    // change, and it is still the resolved `use` permission and the card's own
    // status rather than anything a screen decided.
    assert.ok(list.includes('canBookCard(reading, { userId: profile?.id ?? null, canUse: caps.canUse })'))
    assert.equal(/canVerify/.test(
      list.slice(list.indexOf('canBookCard'), list.indexOf('canBookCard') + 120),
    ), false, 'booking consults the verify permission')
  })

  test('and UNBOOKING is drawn from canUnbookCard, on the detail screen', () => {
    assert.ok(detail.includes('canUnbookCard('))
    assert.ok(detail.includes('{ userId: profile?.id ?? null, canUse: caps.canUse },'))
    // The screenshot count is passed in, because it lives in another table and
    // the database refuses an unbooking while one is attached.
    assert.ok(detail.includes('screenshots.length > 0,'))
    // A refusal is explained rather than left as a grey rectangle.
    assert.ok(detail.includes('unbookBlocker('))
  })

  test('THE WORD IS "UNBOOK", EVERYWHERE A CANDIDATE READS IT', () => {
    // One verb for one action. The control, the confirmation, the busy state
    // and the failure sentence all say it, and "Release" — the word an earlier
    // draft used — survives nowhere a candidate can see, because two words for
    // one action is two things to learn.
    assert.ok(detail.includes('Unbook this review'))
    assert.ok(detail.includes('title="Unbook this review?"'))
    assert.ok(detail.includes("{busy ? 'Unbooking…' : 'Yes, unbook it'}"))
    assert.ok(detail.includes("'That review could not be unbooked.'"))

    const executable = detail.split('\n')
      .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    assert.equal(/\bRelease\b|\breleased\b|\bReleasing\b/.test(executable), false,
      'the retired "Release" wording survives on the detail screen')

    // ...and the confirmation says what actually happens to the review.
    assert.ok(detail.includes('returns to the\n            available pool'))
    assert.ok(detail.includes('It stays approved; you are giving up the booking, not the review.'))
  })

  test('and the trail entry a candidate reads says the same word', () => {
    assert.ok(detail.includes("unbooked:           'Unbooked — back to Available',"))
  })

  test('APPROVAL IS DRAWN FROM THE RESOLVED verify PERMISSION, and from nothing else', () => {
    // The verifier workspace is rendered only for caps.canVerify, which is the
    // resolved permission — never a role. An administrator whose `verify` was
    // revoked in Control Center is offered nothing, exactly as the definer
    // function would refuse them.
    assert.ok(list.includes('if (caps.canVerify) {'))
    const panel = read('src/components/customerReviews/PendingBatches.tsx')
    const executable = panel.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/role\s*===\s*'admin'|isAdmin/.test(executable), false,
      'the approval workspace consults a role')
  })

  test('the Submit button is disabled until every prerequisite clears', () => {
    assert.ok(detail.includes('submissionBlockers(card, screenshots.length)'))
    assert.ok(detail.includes("const blocked = action.to === 'submitted' && blockers.length > 0"))
  })

  test('double submission is stopped by a ref, not only by disabled state', () => {
    for (const [name, source] of [['the list', list], ['the detail screen', detail]] as const) {
      assert.ok(/const (booking|acting) = useRef\(false\)/.test(source), name)
      assert.ok(/if \((booking|acting)\.current/.test(source), name)
    }
  })

  test('the verifier tabs are hidden from non-verifiers', () => {
    assert.ok(list.includes('if (caps.canVerify) {'))
    // ...and a non-verifier who types the URL is put back on Available rather
    // than left on an empty screen with a promising name.
    assert.ok(list.includes("setState({ tab: 'available' })"))
  })

  test('A VERIFIED CARD IS IN NO LIST AT ALL', () => {
    // The requirement, read off the tab definitions rather than described.
    // 'verified' appears in NO tab's status list, so there is no query this
    // screen can issue that would return one — not a filter that hides them,
    // an absence of anything that asks.
    const table = list.slice(list.indexOf('const TAB_STATUSES'), list.indexOf('export function TestCardListScreen'))
    assert.ok(/available: \['available'\]/.test(table))
    assert.ok(/mine:\s*\['booked', 'submitted'\]/.test(table))
    assert.ok(/to_verify:\s*\['submitted'\]/.test(table))
    assert.equal(table.includes("'verified'"), false,
      'some tab still asks the database for verified cards')
  })

  test('THERE IS NO HISTORY TAB, AND NO KEY THAT COULD REACH ONE', () => {
    // Checked on the tab list itself, because a leftover key would still be a
    // valid ?tab= value in the URL even with no button drawn for it.
    const tabs = /const TABS = \[([^\]]*)\]/.exec(list)?.[1] ?? ''
    assert.ok(tabs, 'the tab list is missing')
    assert.deepEqual(
      tabs.split(',').map(t => t.trim().replace(/'/g, '')).filter(Boolean),
      // `pending` and `booked` are the two the approval workflow added, and
      // both are verifier-only. There is still no key a candidate could type
      // that reaches a finished record.
      ['pending', 'available', 'mine', 'booked', 'to_verify'],
    )

    // Nothing draws one, nothing routes to one, and the icon it used is no
    // longer imported — a stray import is how a removed screen comes back.
    const executable = list.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/history/i.test(executable), false, 'the list still mentions history')
    assert.equal(/\bHistory\b/.test(executable), false, 'the History icon is still imported or used')
  })

  test('and the module shell offers no History entry either', () => {
    const shell = read('src/components/layout/CustomerReviewsLayout.tsx')
    const executable = shell.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/history/i.test(executable), false, 'the sidebar still links to history')
    // Five entries now, and three of the five are verifier-only. The two a
    // candidate sees are the two they always saw.
    const items = [...executable.matchAll(/label: '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(items, ['Pending approval', 'Available', 'My reviews', 'Booked', 'To Verify'])

    const verifierOnly = [...executable.matchAll(/label: '([^']+)'[\s\S]*?(?=\{\s*$|\},)/g)]
    assert.ok(verifierOnly.length >= 0)   // structural read below is the assertion
    // Everything but Available and My reviews carries verifierOnly, so a
    // candidate's sidebar is unchanged by this work.
    const entries = executable.slice(executable.indexOf('const NAV_ITEMS'), executable.indexOf(']\n\nexport function'))
    for (const label of ['Pending approval', 'Booked', 'To Verify']) {
      const at = entries.indexOf(`label: '${label}'`)
      assert.ok(at !== -1, `${label} is missing`)
      assert.ok(entries.slice(at, at + 260).includes('verifierOnly: true'),
        `${label} is shown to candidates`)
    }
    for (const label of ['Available', 'My reviews']) {
      const at = entries.indexOf(`label: '${label}'`)
      assert.ok(at !== -1, `${label} is missing`)
      // Each of these is one line, so the next 160 characters cannot reach into
      // the following entry's flag.
      assert.equal(entries.slice(at, at + 160).includes('verifierOnly'), false,
        `${label} became verifier-only`)
    }
  })

  test('THE DETAIL SCREEN DECLINES A VERIFIED CARD TOO', () => {
    // Removing a card from every list while its URL still renders the whole
    // record would be hiding it, not removing it. The detail route is addressed
    // by id, and a verifier who has just verified one is standing on that URL.
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    assert.ok(detail.includes("status === 'verified'"), 'the detail screen still renders a verified card')
    const branch = detail.slice(detail.indexOf("status === 'verified'"))
    assert.ok(branch.slice(0, 200).includes('setNotFound(true)'),
      'a verified card does not fall into the not-available branch')

    // ...and verifying navigates away rather than reloading into that branch,
    // which would read as an error instead of as success.
    assert.ok(detail.includes("router.push('/customer-reviews?tab=to_verify')"))
  })

  test('NOTHING IS DELETED — this is a display rule, not a data change', () => {
    // The record and its trail stay. Asserted against the whole module: no
    // frontend file deletes a card, and the migration still has no DELETE
    // policy for any client role.
    const files = [
      'src/app/customer-reviews/TestCardListScreen.tsx',
      'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
      'src/components/layout/CustomerReviewsLayout.tsx',
    ]
    for (const file of files) {
      const executable = read(file).split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
      assert.equal(/\.delete\(\)/.test(executable), false, `${file} deletes rows`)
    }
  })

  test('and My tests is scoped to the signed-in person in the QUERY too', () => {
    // RLS already narrows a `use` holder to their own cards — but a VERIFIER
    // sees everybody's, so without this their "My tests" tab would show the
    // whole company's work under a possessive heading.
    assert.ok(list.includes("if (tab === 'mine') query = query.eq('booked_by', profile.id)"))
  })

  test('THE LIST IS NOT A DASHBOARD', () => {
    // No scoring, no leaderboard, no totals per employee.
    //
    // Comments are stripped first: this is about what the screen DOES, and the
    // file's own header explains what it deliberately leaves out.
    const executable = list.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    for (const word of ['leaderboard', 'ranking', 'reward', 'incentive', 'sentiment', 'stars']) {
      assert.equal(new RegExp(`\\b${word}`, 'i').test(executable), false, `the list mentions ${word}`)
    }
    assert.equal(/by (owner|employee)|group\s*By|reduce\(/i.test(executable), false)
  })

  test('THE MANDATORY LABEL — everywhere a draft is read, with one deliberate exception', () => {
    // Rendered by a component that takes no content parameter, so no caller can
    // give it different words: it is not sayable in different words, only
    // presentable or absent.
    //
    // WHERE IT APPEARS is one label per DRAFT, never one per page: a banner
    // above a list of eight labels nothing, and internalTest.test.ts asserts
    // that the page-level one is gone. This asserts the surfaces that show a
    // draft's WORDS in full — the Available tab's tile, the detail screen, the
    // complete-review view — all still carry it.
    assert.ok(list.includes('<InternalTestWarning compact />'), 'a card tile has no label')
    assert.ok(detail.includes('<InternalTestWarning />'), 'the detail screen has no label')

    const full = read('src/components/customerReviews/ReviewFullView.tsx')
    assert.ok(full.includes('<InternalTestWarning />'),
      'the complete-review view has no label')

    // THE ONE DELIBERATE EXCEPTION: the compact tile inside the Pending
    // approval workspace. A verifier working that queue already knows — every
    // review reachable from it is, by definition, an unapproved AI draft; the
    // workspace's own heading and copy say so before a single card is shown.
    // Repeating the same four words on twelve compact tiles at once was judged
    // clutter rather than information there, and the label survives ANYWAY the
    // moment a verifier opens one: ReadDraftSheet renders
    // <ReviewFullView card={current} ... />, and that component's own
    // <InternalTestWarning /> is asserted above. This is a narrowing of WHERE
    // the label repeats itself, not a removal of the guarantee that a verifier
    // can always find it before acting on a draft's words.
    const pending = read('src/components/customerReviews/PendingBatches.tsx')
    assert.equal(pending.includes('<InternalTestWarning'), false,
      'the pending-approval tile has the compact label back — was that intended? see the comment above before restoring it')
  })

  test('AND IT NEVER TRAVELS IN THE MESSAGE', () => {
    // It is UI metadata about a draft, and it stays on our screen: a recipient
    // receives a suggested review, not a suggested review annotated with our
    // internal note about where it came from. The full-review sheet shows the
    // label beside the message and NOT inside it, and the message it shows is
    // built by the same single builder the server uses for the wa.me link.
    const full = read('src/components/customerReviews/ReviewFullView.tsx')
    assert.ok(full.includes('const message = useMemo(() => buildReviewMessage({'))
    const pre = full.slice(full.indexOf('data-testid="review-outgoing-message"'))
    assert.equal(pre.slice(0, 400).includes('InternalTestWarning'), false,
      'the label was rendered inside the outgoing message')
  })

  test('THE FULL VIEW PRINTS THE REVIEW ONCE WHEN ONCE IS HONEST', () => {
    // buildReviewMessage carries the draft and nothing else, so the outgoing
    // message is usually the body character for character — and the first
    // version of this view printed the same six hundred characters twice under
    // two headings, which on a phone was an entire extra screen of scrolling
    // that told the reader nothing. Found by rendering it at 390px, not by
    // reading it.
    //
    // It can still differ, because the builder collapses runs of whitespace, so
    // a body holding a line break produces a message that is not identical to
    // it. The two cases are DECIDED BY COMPARISON rather than by assumption,
    // and both branches render the outgoing text — so a candidate always sees
    // what will actually be sent.
    const full = read('src/components/customerReviews/ReviewFullView.tsx')
    assert.ok(full.includes('const identical = message === card.test_body.trim()'))
    assert.ok(full.includes("label={identical ? 'The full review, and the exact message' : 'The full review'}"))
    assert.ok(full.includes('{!identical && ('), 'the differing case has no second block')

    // The outgoing text is rendered in BOTH branches, so neither hides it.
    assert.equal(
      (full.match(/data-testid="review-outgoing-message"/g) ?? []).length, 2,
      'one of the two branches does not render the outgoing message',
    )
    // ...and Copy always copies the BUILT message, never the stored body, so a
    // candidate cannot copy something other than what would be sent.
    assert.ok(full.includes('<CopyMessageButton message={message} />'))
    assert.equal(full.includes('CopyMessageButton message={card.test_body'), false)
  })

  test('THE RENDERING RULES, PINNED', () => {
    const full = read('src/components/customerReviews/ReviewFullView.tsx')

    // 1. IDENTICAL AFTER NORMALISATION → ONE BLOCK, ONE HEADING. The heading
    //    says both things rather than the page saying one thing twice.
    assert.ok(full.includes("label={identical ? 'The full review, and the exact message' : 'The full review'}"))

    // 2. NOT IDENTICAL → TWO BLOCKS, the review and the exact outgoing message
    //    separately, because the candidate is entitled to see the text that
    //    will actually be sent.
    assert.ok(full.includes('{!identical && ('))
    assert.ok(full.includes("<Block label=\"What WhatsApp will be handed\">"))

    // 3. NORMALISATION IS THE APPLICATION'S OWN, not a second opinion about it:
    //    the comparison is against buildReviewMessage's output, which is the
    //    single builder the server uses for the wa.me link.
    assert.ok(full.includes('const identical = message === card.test_body.trim()'))
    assert.ok(full.includes('const message = useMemo(() => buildReviewMessage({'))

    // 4. COPY IS ALWAYS THE OUTGOING MESSAGE, in both branches — never
    //    "whichever block happens to be visible".
    assert.equal((full.match(/<CopyMessageButton message=\{message\} \/>/g) ?? []).length, 1,
      'there is more than one copy control, so they could disagree')
    const copyAt = full.indexOf('<CopyMessageButton message={message} />')
    const secondBlockAt = full.indexOf('{!identical && (')
    assert.ok(copyAt < secondBlockAt,
      'the copy control sits inside the conditional block instead of always rendering')

    // 5. BOOK LIVES IN THE FOOTER OF THIS VIEW AND NOWHERE ELSE.
    assert.ok(full.includes("{booking ? 'Booking…' : 'Book this review'}"))
    const list = read('src/app/customer-reviews/TestCardListScreen.tsx')
    assert.equal(/'Book'|Book this review/.test(list.slice(list.indexOf('function TestCardTile'))), false,
      'the card tile offers a booking control')

    // 6. THE ACTIONS ARE PINNED, so a long title or a long body cannot push
    //    them off the bottom of a phone: they are the sheet's footer, which
    //    does not scroll with the content.
    const sheet = read('src/components/customerReviews/ReviewSheet.tsx')
    assert.ok(sheet.includes("<div className=\"boe-modal-body\" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>"))
    assert.ok(sheet.includes('borderTop: `1px solid ${colors.border}`'))
    assert.ok(sheet.includes("paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))'"))
  })
})

describe('there is no public review destination, and no way to publish', () => {
  const files = [
    'src/app/customer-reviews/TestCardListScreen.tsx',
    'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
    'src/components/customerReviews/WhatsAppLaunch.tsx',
    'src/components/customerReviews/ScreenshotManager.tsx',
    'src/components/customerReviews/ReviewPieces.tsx',
    'src/app/api/customer-reviews/whatsapp/route.ts',
    'src/app/api/customer-reviews/photos/route.ts',
  ]

  test('no screen or route holds a review destination, or an action that posts one', () => {
    // MATCHED AS CODE, NOT AS PROSE. An earlier version of this test searched
    // for the word "publish" anywhere in the file and failed on the list
    // screen's own reassurance — "nothing is published anywhere" — which is a
    // sentence the module should keep, not one it should lose to a test. What
    // must not exist is a DESTINATION or an ACTION, so that is what is checked:
    // an identifier, a URL, or a link out of the app.
    for (const file of files) {
      const source = read(file).split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

      for (const identifier of ['reviewUrl', 'review_url', 'reviewLink', 'publishReview',
                                'postReview', 'shareToGoogle', 'googleReviewUrl']) {
        assert.equal(source.includes(identifier), false, `${file} declares ${identifier}`)
      }

      // Any absolute http(s) address at all. The one address this module can
      // produce comes from the server, so no screen has a reason to hold one.
      const urls = [...source.matchAll(/https?:\/\/[^'"\s`)]+/g)].map(m => m[0])
      assert.deepEqual(urls, [], `${file} contains a hard-coded address: ${urls.join(', ')}`)
    }
  })

  test('the ONLY external address the module can produce is wa.me', () => {
    const internalTest = read('src/lib/customerReviews/internalTest.ts')
    assert.ok(internalTest.includes('https://wa.me/'))
    // And it is built in exactly one place.
    const builders = files
      .map(f => read(f))
      .filter(src => src.includes('https://wa.me/'))
    assert.equal(builders.length, 0, 'a screen or route builds a wa.me URL of its own')
  })
})

describe('the module never claims a message was sent', () => {
  const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
  const launch = read('src/components/customerReviews/WhatsAppLaunch.tsx')

  test('OPENING WHATSAPP IS NOT CONFIRMING IT WAS SENT', () => {
    // Two components, two controls, two calls. The whole module exists to
    // demonstrate that collapsing them is wrong.
    assert.ok(launch.includes('export function WhatsAppTestPanel'))
    assert.ok(launch.includes('export function ConfirmSentControl'))
    assert.ok(detail.includes("supabase.rpc('confirm_customer_review_test_card_sent'"))
    // Opening transitions nothing.
    assert.equal(launch.includes('transition_customer_review_test_card'), false)
    assert.equal(launch.includes('confirm_customer_review_test_card_sent'), false)
  })

  test('the link is built by the SERVER, never by the browser', () => {
    // If the browser assembled the URL the allowlist would be a suggestion.
    assert.equal(launch.includes('https://wa.me/'), false, 'the browser builds its own wa.me URL')
    assert.ok(launch.includes("fetch('/api/customer-reviews/whatsapp'"))
    assert.ok(launch.includes('buildWaMeUrl') === false, 'the browser calls the URL builder directly')
  })

  test('the server’s answer is awaited BEFORE anything opens', () => {
    const body = launch.slice(launch.indexOf('const launch = useCallback'))
    assert.ok(
      body.indexOf("fetch('/api/customer-reviews/whatsapp'") < body.indexOf('tab.location.href = built.waMeUrl'),
      'the check must land before WhatsApp opens',
    )
    assert.ok(body.includes('tab?.close()'))
  })

  test('previewing the message records nothing', () => {
    // `record` defaults to false on the server and is not sent by the preview
    // call, so reading what you are about to send never writes to the card.
    const preview = launch.slice(launch.indexOf('const loadPreview = useCallback'), launch.indexOf('const ready ='))
    assert.equal(preview.includes('record: true'), false)
  })

  test('the button says what it does, and does not claim delivery', () => {
    // Whitespace-normalised: the copy is JSX and wraps wherever the line ends,
    // so a phrase search on the raw source would break on a reflow rather than
    // on a change of meaning.
    const copy = launch.replace(/\s+/g, ' ')
    assert.ok(launch.includes('Open WhatsApp'))
    assert.ok(copy.includes('still have to press send there'))
    assert.ok(copy.includes('BOE never sends it for you'))
    assert.ok(copy.includes('Opening WhatsApp does not do it for you'))
    for (const word of ['delivered', 'message sent successfully', 'sent to the customer']) {
      assert.equal(copy.toLowerCase().includes(word), false, word)
    }
  })

  test('a screenshot is described as proof the MESSAGE was sent, never of a review', () => {
    const pieces = read('src/components/customerReviews/ReviewPieces.tsx').replace(/\s+/g, ' ')
    assert.ok(pieces.includes('evidence that the message was sent'))
    assert.ok(pieces.includes('not proof that a review was published'))
    // And it still refuses the stronger claim: a screenshot is not evidence a
    // review exists anywhere.
    assert.equal(/proof that (a|one) review (exists|was left)/i.test(pieces), false)
    assert.ok(detail.includes('<ScreenshotIsNotProofNote />'))
  })

  test('the detail screen keeps the five facts separate', () => {
    for (const label of [
      'Booked',
      'WhatsApp opened',
      'Candidate confirmed sent',
      'Submitted',
      'Verified',
    ]) {
      assert.ok(detail.includes(label), `missing fact: ${label}`)
    }
  })
})
