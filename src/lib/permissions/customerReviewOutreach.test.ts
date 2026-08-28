/**
 * Customer Review Outreach — permissions, module visibility, and the screens
 * that read them.
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
  canEditThisRequest,
  deriveCustomerReviewCapabilities,
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
    assert.equal(mod!.displayName, 'Customer Review Outreach')
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

describe('editing one request', () => {
  const OWNER = 'user-owner'
  const OTHER = 'user-other'
  const useCaps = deriveCustomerReviewCapabilities('member', allow('use'))
  const verifyCaps = deriveCustomerReviewCapabilities('member', allow('verify'))

  test('the owner may edit while it is still being prepared', () => {
    for (const status of ['draft', 'ready_to_send']) {
      assert.equal(canEditThisRequest({ status, created_by: OWNER }, OWNER, useCaps, 'member'), true, status)
    }
  })

  test('NOBODY edits a request that has already reached a customer', () => {
    for (const status of ['sent', 'customer_responded', 'verified', 'closed', 'cancelled']) {
      assert.equal(canEditThisRequest({ status, created_by: OWNER }, OWNER, useCaps, 'member'), false, status)
      // Not even an admin: what the customer received is a fact.
      assert.equal(canEditThisRequest({ status, created_by: OWNER }, OTHER, useCaps, 'admin'), false, status)
    }
  })

  test('a VERIFIER does not author somebody else’s outreach', () => {
    assert.equal(canEditThisRequest({ status: 'draft', created_by: OWNER }, OTHER, verifyCaps, 'member'), false)
  })

  test('another `use` holder cannot edit a request that is not theirs', () => {
    assert.equal(canEditThisRequest({ status: 'draft', created_by: OWNER }, OTHER, useCaps, 'member'), false)
  })

  test('an admin may fix a draft', () => {
    assert.equal(canEditThisRequest({ status: 'draft', created_by: OWNER }, OTHER, useCaps, 'admin'), true)
  })

  test('a signed-out caller edits nothing', () => {
    assert.equal(canEditThisRequest({ status: 'draft', created_by: OWNER }, null, useCaps, 'member'), false)
  })
})

// ── 3. The screens ──────────────────────────────────────────────────────────

describe('the route guard', () => {
  const guard = read('src/app/customer-reviews/layout.tsx')

  test('every screen in the module is behind it', () => {
    // A layout.tsx at the module root wraps /customer-reviews, /new, /[id] and
    // /[id]/edit alike, so there is no route that can mount unguarded.
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
  const list = read('src/app/customer-reviews/CustomerReviewListScreen.tsx')
  const detail = read('src/app/customer-reviews/[id]/RequestDetailScreen.tsx')
  const form = read('src/components/customerReviews/RequestForm.tsx')

  test('every status action comes from availableActions, never from an inline test', () => {
    assert.ok(detail.includes('const actions = availableActions(request, {'))
    assert.ok(detail.includes('canVerify: caps.canVerify,'))
    // No hand-rolled status branching deciding what to offer.
    assert.equal(/status === 'verified' &&/.test(detail), false)
  })

  test('every status change goes through the one RPC', () => {
    assert.ok(detail.includes("supabase.rpc('transition_customer_review_request'"))
    // Nothing writes a status column directly.
    assert.equal(/\.update\(\{[^}]*status:/.test(detail), false)
    assert.equal(/\.update\(\{[^}]*status:/.test(form), false)
  })

  test('marking a request ready goes through the RPC too, so the DB re-checks it', () => {
    assert.ok(form.includes("supabase.rpc('transition_customer_review_request'"))
    assert.ok(form.includes("p_next_status: 'ready_to_send'"))
  })

  test('the Ready to Send button is disabled until every blocker clears', () => {
    assert.ok(form.includes('disabled={saving || blockers.length > 0}'))
    assert.ok(form.includes('readyToSendBlockers('))
  })

  test('double submission is stopped by a ref, not only by disabled state', () => {
    for (const [name, source] of [['the form', form], ['the detail screen', detail]] as const) {
      assert.ok(source.includes('const inFlight = useRef(false)'), name)
      assert.ok(source.includes('if (inFlight.current'), name)
    }
  })

  test('the verifier queue and its tab are hidden from non-verifiers', () => {
    assert.ok(list.includes('...(caps.canVerify ? [{'))
  })

  test('THE LIST IS NOT A DASHBOARD', () => {
    // No scoring, no leaderboard, no totals per employee — a screen that
    // measured employees on reviews collected would be an incentive to collect
    // them by the wrong means.
    //
    // Comments are stripped first: this is about what the screen DOES, and the
    // file's own header explains what it deliberately leaves out.
    const executable = list.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    for (const word of ['leaderboard', 'ranking', 'reward', 'incentive', 'sentiment', 'rating', 'stars']) {
      assert.equal(new RegExp(`\\b${word}`, 'i').test(executable), false, `the list mentions ${word}`)
    }
    // And no per-employee roll-up: the only numbers are how many rows a tab
    // holds, which every list in this app shows.
    assert.equal(/by (owner|employee)|group\s*By|reduce\(/i.test(executable), false)
  })
})

describe('the module never claims a message was sent, or a review posted', () => {
  const detail = read('src/app/customer-reviews/[id]/RequestDetailScreen.tsx')
  const launch = read('src/components/customerReviews/WhatsAppLaunch.tsx')

  test('opening WhatsApp writes only the opened record', () => {
    assert.ok(launch.includes("supabase.rpc('record_customer_review_whatsapp_opened'"))
    // It must not transition anything.
    assert.equal(launch.includes('transition_customer_review_request'), false)
  })

  test('the RPC is awaited BEFORE the customer’s chat opens', () => {
    const body = launch.slice(launch.indexOf('const launch = useCallback'))
    assert.ok(
      body.indexOf('record_customer_review_whatsapp_opened') < body.indexOf('tab.location.href = url'),
      'the database check must land before the message reaches WhatsApp',
    )
    assert.ok(body.includes('tab?.close()'))
  })

  test('the button says what it does, and does not claim delivery', () => {
    // Whitespace-normalised: the copy is JSX and wraps wherever the line ends,
    // so a phrase search on the raw source would break on a reflow rather than
    // on a change of meaning.
    const copy = launch.replace(/\s+/g, ' ')
    assert.ok(launch.includes('Open WhatsApp'))
    assert.ok(copy.includes('still have to press send there'))
    assert.ok(copy.includes('BOE never sends it for you'))
    for (const word of ['delivered', 'message sent successfully', 'sent to the customer']) {
      assert.equal(copy.toLowerCase().includes(word), false, word)
    }
  })

  test('AND IT SAYS THE PHOTOGRAPHS ARE NOT SENT', () => {
    // wa.me carries a phone number and a text parameter. It cannot attach a
    // file, so any wording implying the project photographs go with the message
    // would be false — and an employee would stop sending them by hand.
    const copy = launch.replace(/\s+/g, ' ')
    assert.ok(copy.includes('no photographs are attached'))
    const form = read('src/components/customerReviews/RequestForm.tsx').replace(/\s+/g, ' ')
    assert.ok(form.includes('<strong> cannot</strong> attach photographs to it'))
    assert.ok(form.includes('never sends them automatically'))
    // And it says what the employee must do instead, which is the part that
    // stops a photograph silently never reaching anybody.
    assert.ok(form.includes('attach the files yourself in the chat before you send'))

    const detail = read('src/app/customer-reviews/[id]/RequestDetailScreen.tsx').replace(/\s+/g, ' ')
    assert.ok(detail.includes('<strong>BOE cannot attach them to WhatsApp</strong>'))
    assert.ok(detail.includes('attach the files yourself in the chat'))
    // A download control exists so they can actually do it.
    assert.ok(detail.includes('downloadable'))
  })

  test('the detail screen keeps the six milestones separate', () => {
    for (const label of [
      'Invitation prepared',
      'WhatsApp opened',
      'Employee confirmed sent',
      'Customer responded',
      'Public review evidence supplied',
      'Verified',
    ]) {
      assert.ok(detail.includes(label), `missing milestone: ${label}`)
    }
  })

  test('evidence is described as unverified until a verifier says otherwise', () => {
    assert.ok(detail.includes('It does not mean the request has been'))
    assert.ok(detail.includes('only a verifier can say that'))
  })
})
