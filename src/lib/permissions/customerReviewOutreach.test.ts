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
    assert.equal(mod!.displayName, 'Review Workflow Test (Internal)')
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

  test('an admin holds everything without a single grant row', () => {
    assert.deepEqual(
      deriveCustomerReviewCapabilities('admin', []),
      { canAccessModule: true, canUse: true, canVerify: true },
    )
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
  const adminCaps = deriveCustomerReviewCapabilities('admin', [])

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
    assert.ok(list.includes('canBookCard(card, {'))
    assert.ok(list.includes('canUse: caps.canUse,'))
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

  test('A VERIFIED CARD IS IN NO ACTIVE LIST', () => {
    // The requirement, read off the tab definitions rather than described. It
    // is not filtered out cosmetically: 'verified' is simply not in either
    // active tab's status list.
    const table = list.slice(list.indexOf('const TAB_STATUSES'), list.indexOf('export function TestCardListScreen'))
    assert.ok(/available: \['available'\]/.test(table))
    assert.ok(/mine:\s*\['booked', 'submitted'\]/.test(table))
    assert.ok(/history:\s*\['verified'\]/.test(table))
    const active = table.slice(table.indexOf('available:'), table.indexOf('to_verify:'))
    assert.equal(active.includes("'verified'"), false, 'a verified card is still in an active tab')
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

  test('EVERY CARD CARRIES THE MANDATORY LABEL', () => {
    // Rendered by a component that takes no content parameter, so no caller can
    // give it different words or leave it out of one branch.
    assert.ok(list.includes('<InternalTestWarning />'), 'the list page has no label')
    assert.ok(list.includes('<InternalTestWarning compact />'), 'a card tile has no label')
    assert.ok(detail.includes('<InternalTestWarning />'), 'the detail screen has no label')
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

  test('a screenshot is described as proof of the WORKFLOW, never of a review', () => {
    const pieces = read('src/components/customerReviews/ReviewPieces.tsx').replace(/\s+/g, ' ')
    assert.ok(pieces.includes('evidence that the workflow was exercised'))
    assert.ok(pieces.includes('not a customer review, not proof that one exists'))
    assert.ok(detail.includes('<ScreenshotIsNotProofNote />'))
  })

  test('the detail screen keeps the five facts separate', () => {
    for (const label of [
      'Booked',
      'WhatsApp opened',
      'Tester confirmed sent',
      'Submitted',
      'Verified',
    ]) {
      assert.ok(detail.includes(label), `missing fact: ${label}`)
    }
  })
})
