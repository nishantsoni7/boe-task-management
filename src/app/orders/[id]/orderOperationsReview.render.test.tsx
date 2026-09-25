/**
 * The operations reviewer's decision on the attention strip, and its dialog
 * (20261229000000), drawn.
 *
 * renderToStaticMarkup, no browser: what a reader sees on the strip for each
 * state of the version in force, that the controls appear ONLY when the rules
 * module says so — never from being an admin — and that the page draws ONE
 * production decision: the strip's, with no Operations review card and no
 * second header button on a handoff Order.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderOperationsReview.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OperationsReviewActions } from './OrderStatusWorkspace'
import { OrderAttentionBar } from './OrderWorkspace'
import { OperationsHandoffDecisionModal } from './OrderRevisionModals'
import {
  describeOperationsHandoff,
  type PersistedOperationsHandoff,
} from '@/lib/orders/operationsHandoff'
import { arrangeOrderActions, orderAttentionItems } from '@/lib/orders/orderWorkspace'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const NISHANT = 'aaaaaaaa-0000-0000-0000-000000000001'
const NITISH  = 'aaaaaaaa-0000-0000-0000-000000000002'
const NAMES = new Map([[NISHANT, 'Nishant'], [NITISH, 'Nitish']])
const when = (iso: string | null) => (iso ? `on ${iso.slice(0, 10)}` : '—')

function handoff(over: Partial<PersistedOperationsHandoff> = {}): PersistedOperationsHandoff {
  return {
    id: 'h1', order_id: 'o1', pi_version_id: 'v1', submission_id: 's1', version_number: 1,
    approved_by: NISHANT, approved_at: '2026-09-20T10:00:00Z',
    assigned_to: NITISH, assigned_at: '2026-09-20T10:00:00Z', unassigned_reason: null,
    production_alignment_at_approval: 'not_aligned', prior_handoff_status: null,
    status: 'awaiting',
    accepted_by: null, accepted_at: null, accepted_note: null,
    acceptance_withdrawn_by: null, acceptance_withdrawn_at: null, acceptance_withdrawn_reason: null,
    clarification_by: null, clarification_at: null, clarification_reason: null,
    superseded_at: null, superseded_by_version_id: null, created_at: '2026-09-20T10:00:00Z',
    ...over,
  }
}

const noop = () => {}
const view = (live: PersistedOperationsHandoff | null, viewerId: string | null, extra: Partial<Parameters<typeof describeOperationsHandoff>[0]> = {}) =>
  describeOperationsHandoff({
    live, hasSourcePi: true, namesById: NAMES, formatWhen: when,
    viewerId, viewingAs: false, orderStatus: 'running',
    productionAligned: false, productionAlignedAt: null, ...extra,
  })

/**
 * The attention strip exactly as the page composes it: the items from
 * orderAttentionItems, the anchor while the review is open, and the decision
 * only while the strip names the review AND view.actions offers it.
 */
const strip = (v: ReturnType<typeof view>, extra: Partial<Parameters<typeof orderAttentionItems>[0]> = {}) => {
  const items = orderAttentionItems({
    status: 'running', productionAligned: v.kind === 'recorded' && v.alignment.aligned,
    hasSalesperson: true, hasDueDate: true, hasLeadSource: true, isOverdue: false,
    awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
    documentsFailed: false, documentsOutdated: false,
    operationsReview: v.kind === 'recorded' && v.status !== 'accepted'
      ? { versionNumber: v.versionNumber, status: v.status, unassigned: v.unassigned }
      : null,
    ...extra,
  })
  const open = items.some(i => i.key === 'operations_review')
  const offered = open && v.kind === 'recorded' && (v.actions.accept || v.actions.cannotAccept)
  return renderToStaticMarkup(
    <OrderAttentionBar
      id={open ? 'operations-review' : undefined}
      items={items}
      actions={offered ? <OperationsReviewActions view={v} busy={false} onAccept={noop} onCannotAccept={noop} /> : undefined}
    />,
  )
}

const accepted = () => handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-21T09:00:00Z' })

describe('the attention strip carries the decision, state by state', () => {
  test('awaiting, for the reviewer: the message on the left, BOTH controls on the right', () => {
    const html = strip(view(handoff(), NITISH))
    assert.match(html, /id="operations-review"/)
    assert.match(html, /1 item needs attention/)
    assert.match(html, /<div class="order-attention-message">.*PI V1 awaiting operations review.*<\/div><div class="order-attention-actions">/)
    assert.match(html, /<div class="order-attention-actions"><button[^>]*>Cannot accept<\/button><button[^>]*>Accept for production<\/button><\/div>/)
    assert.doesNotMatch(html, /Withdraw acceptance/)
  })

  test('the facts the card restated are NOT repeated on the strip', () => {
    const html = strip(view(handoff(), NITISH))
    assert.doesNotMatch(html, /Approved by/)
    assert.doesNotMatch(html, /Operations reviewer/)
    assert.doesNotMatch(html, /Production alignment/)
    assert.doesNotMatch(html, /Open current PI/)
    assert.doesNotMatch(html, /Nitish|Nishant/)
  })

  test('awaiting, for the approving admin: the same message, NO controls and no empty slot', () => {
    const html = strip(view(handoff(), NISHANT))
    assert.match(html, /PI V1 awaiting operations review/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /order-attention-actions/)
  })

  test('unassigned: both items counted, nobody offered a control', () => {
    const html = strip(view(handoff({ assigned_to: null, assigned_at: null, unassigned_reason: 'no_reviewer' }), NISHANT))
    assert.match(html, /2 items need attention/)
    assert.match(html, /No operations reviewer assigned/)
    assert.doesNotMatch(html, /<button/)
  })

  test('flagged: the red item, and only Accept remains for the reviewer', () => {
    const html = strip(view(handoff({ status: 'clarification_needed', clarification_by: NITISH, clarification_at: '2026-09-21T09:00:00Z', clarification_reason: 'Which fabric?' }), NITISH))
    assert.match(html, /PI V1 flagged by operations: clarification needed/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
  })

  // Accepting aligns, so an accepted version's Order is aligned (an accepted
  // version on a NOT aligned Order is a production hold, 20270104000000).
  test('accepted: the review is resolved, so the strip neither names it nor offers a decision', () => {
    assert.equal(strip(view(accepted(), NITISH, { productionAligned: true })), '', 'nothing else needs attention on this Order')
    assert.equal(
      renderToStaticMarkup(<OperationsReviewActions view={view(accepted(), NITISH, { productionAligned: true })} busy={false} onAccept={noop} onCannotAccept={noop} />),
      '',
    )
  })

  test('accepted beside other gaps: those items and their count are untouched, and no decision or anchor is drawn', () => {
    const html = strip(view(accepted(), NITISH, { productionAligned: true }), { hasDueDate: false, pendingChangeRequests: 2 })
    assert.match(html, /2 items need attention/)
    assert.match(html, /Due date not set/)
    assert.match(html, /2 change requests awaiting review/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /id="operations-review"/)
  })

  test('the review beside other gaps: every item counted, the decision still on the right', () => {
    const html = strip(view(handoff(), NITISH), { hasDueDate: false })
    assert.match(html, /2 items need attention/)
    assert.match(html, /Due date not set/)
    assert.match(html, /<button[^>]*>Accept for production/)
  })

  test('busy: both controls disabled while a decision is saving', () => {
    const html = renderToStaticMarkup(<OperationsReviewActions view={view(handoff(), NITISH)} busy onAccept={noop} onCannotAccept={noop} />)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
  })

  test('not recorded: no decision drawn', () => {
    assert.equal(renderToStaticMarkup(<OperationsReviewActions view={view(null, NITISH)} busy={false} onAccept={noop} onCannotAccept={noop} />), '')
  })
})

describe('after dispatch, and after cancellation', () => {
  // The page hands the view the Order's own status, and the strip's items the
  // same one; the header overflow reads view.actions.withdraw. All three here.
  const at = (status: string, live: PersistedOperationsHandoff, viewer: string, extra: Partial<Parameters<typeof orderAttentionItems>[0]> = {}) => {
    const v = view(live, viewer, { orderStatus: status })
    return {
      html: strip(v, { status, ...extra }),
      overflow: arrangeOrderActions({
        alignAction: null, canAmend: false, canRequest: false, canReviewChangeRequests: false, canCleanUp: false,
        canWithdrawAcceptance: v.kind === 'recorded' && v.actions.withdraw,
      }).overflow,
    }
  }
  const flagged = () => handoff({ status: 'clarification_needed', clarification_by: NITISH, clarification_at: '2026-09-21T09:00:00Z', clarification_reason: 'Which fabric?' })

  test('dispatched, awaiting: the reviewer keeps the item AND both decisions', () => {
    const { html } = at('dispatched', handoff(), NITISH)
    assert.match(html, /id="operations-review"/)
    assert.match(html, /1 item needs attention/)
    assert.match(html, /PI V1 awaiting operations review/)
    assert.match(html, /<button[^>]*>Cannot accept<\/button><button[^>]*>Accept for production<\/button>/)
  })

  test('dispatched, awaiting: the approving admin sees the item and no decision', () => {
    const { html } = at('dispatched', handoff(), NISHANT)
    assert.match(html, /PI V1 awaiting operations review/)
    assert.doesNotMatch(html, /<button/)
  })

  test('dispatched: the open-Order gaps stay hidden, so the count is the review alone', () => {
    const { html } = at('dispatched', handoff(), NITISH, { hasDueDate: false, hasSalesperson: false, isOverdue: true })
    assert.match(html, /1 item needs attention/)
    assert.doesNotMatch(html, /Due date|Salesperson/)
  })

  test('dispatched, flagged: the red item, and only Accept for the reviewer', () => {
    const { html } = at('dispatched', flagged(), NITISH)
    assert.match(html, /PI V1 flagged by operations: clarification needed/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
  })

  test('dispatched, accepted: no strip, and Withdraw acceptance is in the overflow for the reviewer only', () => {
    const mine = at('dispatched', accepted(), NITISH)
    assert.equal(mine.html, '')
    assert.deepEqual(mine.overflow, ['withdraw_acceptance'])
    assert.deepEqual(at('dispatched', accepted(), NISHANT).overflow, [])
  })

  test('running, accepted: Withdraw acceptance in the overflow for the reviewer only', () => {
    assert.deepEqual(at('running', accepted(), NITISH).overflow, ['withdraw_acceptance'])
    assert.deepEqual(at('running', accepted(), NISHANT).overflow, [])
  })

  test('cancelled: the RPC refuses, so no item, no decision and no withdrawal — awaiting, flagged or accepted', () => {
    for (const live of [handoff(), flagged()]) {
      const { html, overflow } = at('cancelled', live, NITISH)
      assert.equal(html, '')
      assert.deepEqual(overflow, [])
    }
    assert.deepEqual(at('cancelled', accepted(), NITISH).overflow, [])
  })

  test('cancelled beside money: the other items and their count are untouched', () => {
    const { html } = at('cancelled', handoff(), NITISH, { awaitingVerificationCount: 1 })
    assert.match(html, /1 item needs attention/)
    assert.match(html, /1 payment awaiting Finance verification/)
    assert.doesNotMatch(html, /operations review|<button/)
  })
})

describe('the decision dialog', () => {
  test('accepting says what it records — alignment included — and what it does not claim', () => {
    const html = renderToStaticMarkup(
      <OperationsHandoffDecisionModal orderNumber="0524" versionLabel="PI V2" decision="accepted" saving={false} failure={null} onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Accept this PI version for production/)
    assert.match(html, /Order 0524 · PI V2/)
    assert.match(html, /aligns the Order for production against this version/)
    assert.match(html, /does not say any manufacturing work is done/)
    assert.match(html, /Note \(optional\)/)
  })

  test('flagging asks for the reason and names the button honestly', () => {
    const html = renderToStaticMarkup(
      <OperationsHandoffDecisionModal orderNumber="0524" versionLabel="PI V2" decision="clarification_needed" saving={false} failure="A newer PI version has been approved since this page loaded. Refresh to review the current one." onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Cannot accept this PI version/)
    assert.match(html, /stays not aligned for production/)
    assert.match(html, /What needs clarifying/)
    assert.match(html, /A newer PI version has been approved/)
    assert.match(html, /<button[^>]*>Cannot accept/)
  })

  test('withdrawing is the same decision on an accepted version, said as a withdrawal', () => {
    const html = renderToStaticMarkup(
      <OperationsHandoffDecisionModal orderNumber="0524" versionLabel="PI V2" decision="clarification_needed" withdrawing saving={false} failure={null} onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Withdraw the acceptance of this PI version/)
    assert.match(html, /takes back the acceptance .* and the production alignment that came with it/)
    assert.match(html, /The acceptance stays on record/)
    assert.match(html, /<button[^>]*>Withdraw acceptance/)
  })
})

describe('Order 0524: an approval from before handoffs, sent to operations later (20261230000000)', () => {
  // The shape the one-time migration writes: V1's own approval (Nishant,
  // 21 September) kept as it was; the handoff itself created and addressed to
  // Nitish on 23 September; awaiting; the Order not aligned.
  const OTHER_ADMIN = 'aaaaaaaa-0000-0000-0000-000000000003'
  const late = handoff({
    approved_by: NISHANT, approved_at: '2026-09-21T17:07:25Z',
    assigned_to: NITISH, assigned_at: '2026-09-23T12:30:00Z',
    created_at: '2026-09-23T12:30:00Z',
  })

  test('Nitish sees "PI V1 awaiting operations review" and BOTH decisions on the strip', () => {
    const html = strip(view(late, NITISH))
    assert.match(html, /1 item needs attention/)
    assert.match(html, /PI V1 awaiting operations review/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.match(html, /<button[^>]*>Cannot accept/)
  })

  test('Nishant, the approving admin, sees the same strip and no decision', () => {
    const html = strip(view(late, NISHANT))
    assert.match(html, /PI V1 awaiting operations review/)
    assert.doesNotMatch(html, /<button/)
  })

  test('any other admin sees no decision either', () => {
    assert.doesNotMatch(strip(view(late, OTHER_ADMIN)), /<button/)
  })

  test('an admin VIEWING AS Nitish is not lent his decision', () => {
    assert.doesNotMatch(strip(view(late, null, { viewingAs: true })), /<button/)
  })

  test('Cannot accept opens the reason dialog', () => {
    const html = renderToStaticMarkup(
      <OperationsHandoffDecisionModal orderNumber="0524" versionLabel="PI V1" decision="clarification_needed" saving={false} failure={null} onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Cannot accept this PI version/)
    assert.match(html, /Order 0524 · PI V1/)
    assert.match(html, /What needs clarifying/)
  })
})

describe('the page draws ONE production decision', () => {
  const page = read('src/app/orders/[id]/page.tsx')
  const body = page.slice(page.indexOf('<OrdersLayout'))

  test('no Operations review card; the decision rides on the attention strip', () => {
    assert.doesNotMatch(page, /OrderOperationsReviewCard/)
    assert.doesNotMatch(body, /Loading operations review/)
    assert.equal((body.match(/<OperationsReviewActions/g) ?? []).length, 1)
    assert.ok(body.indexOf('<OrderAttentionBar') < body.indexOf('<OperationsReviewActions'))
    assert.ok(body.indexOf('<OperationsReviewActions') < body.indexOf('<OrderDocumentsRow>'))
    assert.match(page, /const operationsReviewOpen = attention\.some\(item => item\.key === 'operations_review'\)/)
    assert.match(body, /id=\{operationsReviewOpen \? OPERATIONS_REVIEW_ANCHOR : undefined\}/)
    assert.match(body, /actions=\{operationsDecisionOffered \?/)
  })

  test('the strip opens the SAME dialog the card did, clearing the last failure first', () => {
    assert.match(body, /onAccept=\{\(\) => \{ setHandoffError\(null\); setHandoffDialog\('accepted'\) \}\}/)
    assert.match(body, /onCannotAccept=\{\(\) => \{ setHandoffError\(null\); setHandoffDialog\('clarification_needed'\) \}\}/)
    assert.equal((body.match(/<OperationsHandoffDecisionModal/g) ?? []).length, 1)
  })

  test('Withdraw acceptance survives, in the header overflow, from view.actions', () => {
    assert.match(page, /canWithdrawAcceptance: operationsView\?\.kind === 'recorded' && operationsView\.actions\.withdraw/)
    assert.match(page, /case 'withdraw_acceptance': setHandoffError\(null\); setHandoffDialog\('clarification_needed'\); return/)
    assert.match(body, /withdrawing=\{handoffDialog === 'clarification_needed' && operationsView\.status === 'accepted'\}/)
  })

  test('no header Align button on a handoff Order; the legacy Order keeps it', () => {
    assert.match(page, /alignAction: operationsSplit\.live \? null : production\?\.action \? \(productionAligned \? 'unalign' : 'align'\) : null/)
  })

  test('the Production summary row names the version and the acceptance behind the alignment', () => {
    assert.match(page, /productionLabel: handoffAlignment\?\.label \?\? production\?\.label \?\? '—'/)
    assert.match(page, /productionLine: handoffAlignment \? handoffAlignment\.line : \(production\?\.line \?\? null\)/)
  })

  test('a decision re-reads the handoff AND the Order row, because acceptance moves the alignment columns', () => {
    const fn = page.slice(page.indexOf('const decideHandoff'), page.indexOf('const decideHandoff') + 2200)
    // …and the document submissions: accepting the version accepts the files
    // sent with the PI (20261231000000 §11e).
    assert.match(fn, /await Promise\.all\(\[reloadHandoffs\(\), reloadOrderRow\(\), docSubs\.reload\(\)\]\)/)
    assert.doesNotMatch(fn, /loadOrder\(\)/)
  })
})
