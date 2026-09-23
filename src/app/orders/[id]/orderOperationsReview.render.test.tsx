/**
 * The Operations review card and its decision dialog (20261229000000), drawn.
 *
 * renderToStaticMarkup, no browser: what a reader sees for each state of the
 * version in force, that the controls appear ONLY when the rules module says
 * so — never from being an admin — and that the page draws ONE production
 * decision: the card's, with no second header button on a handoff Order.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderOperationsReview.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderOperationsReviewCard } from './OrderStatusWorkspace'
import { OperationsHandoffDecisionModal } from './OrderRevisionModals'
import {
  describeOperationsHandoff,
  describeOperationsHandoffHistory,
  type PersistedOperationsHandoff,
} from '@/lib/orders/operationsHandoff'
import type { PiVersionView } from '@/lib/orders/orderPiVersions'

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

const version = (n: number, status: PiVersionView['status'], revisionReason: string | null = null): PiVersionView => ({
  id: `v${n}`, versionNumber: n, label: `PI V${n}`, status, statusLabel: status, tone: 'neutral',
  workbookPath: `submissions/s1/original/v${n}.xlsx`, workbookName: `v${n}.xlsx`,
  uploadedBy: null, uploadedAt: null, revisionReason, decidedAt: null, decisionLine: null, decisionReason: null,
} as unknown as PiVersionView)

const noop = () => {}
const view = (live: PersistedOperationsHandoff | null, viewerId: string | null, extra: Partial<Parameters<typeof describeOperationsHandoff>[0]> = {}) =>
  describeOperationsHandoff({
    live, hasSourcePi: true, namesById: NAMES, formatWhen: when,
    viewerId, viewingAs: false, orderStatus: 'running',
    productionAligned: false, productionAlignedAt: null, ...extra,
  })
const card = (v: ReturnType<typeof view>, opts: { history?: PersistedOperationsHandoff[]; current?: PiVersionView | null; previous?: PiVersionView | null } = {}) =>
  renderToStaticMarkup(
    <OrderOperationsReviewCard
      view={v}
      history={describeOperationsHandoffHistory({ history: opts.history ?? [], namesById: NAMES, formatWhen: when })}
      busy={false}
      onAccept={noop}
      onCannotAccept={noop}
      onWithdraw={noop}
      currentVersion={opts.current ?? null}
      previousVersion={opts.previous ?? null}
      onOpenVersion={noop}
      openingVersion={false}
    />,
  )

describe('the card, state by state', () => {
  test('awaiting, for the reviewer: version, approver, reviewer, status, alignment, and BOTH controls', () => {
    const html = card(view(handoff(), NITISH))
    assert.match(html, /id="operations-review"/)
    assert.match(html, /Operations review/)
    assert.match(html, /PI V1/)
    assert.match(html, /Awaiting operations review/)
    assert.match(html, /Approved by Nishant · on 2026-09-20/)
    assert.match(html, /Nitish/)
    assert.match(html, /Production alignment/)
    assert.match(html, /Not Aligned/)
    assert.match(html, /Awaiting operations acceptance of PI V1/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.match(html, /<button[^>]*>Cannot accept/)
    assert.doesNotMatch(html, /Withdraw acceptance/)
    assert.match(html, /aligns the Order for production against this version/, 'what acceptance means is stated')
    assert.doesNotMatch(html, /Only the assigned operations reviewer/)
  })

  test('awaiting, for the approving admin: the same facts, NO controls, and why', () => {
    const html = card(view(handoff(), NISHANT))
    assert.match(html, /Awaiting operations review/)
    assert.doesNotMatch(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
    assert.match(html, /Only the assigned operations reviewer can accept/)
    assert.match(html, /Being an administrator does not count/)
  })

  test('unassigned: says so in words, points at Control Center, offers nobody a control', () => {
    const html = card(view(handoff({ assigned_to: null, assigned_at: null, unassigned_reason: 'no_reviewer' }), NISHANT))
    assert.match(html, /No operations reviewer assigned/)
    assert.match(html, /Control Center/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /Accepted/)
  })

  test('unassigned because the configured reviewer cannot open this Order: says so, and what to do', () => {
    const html = card(view(handoff({ assigned_to: null, assigned_at: null, unassigned_reason: 'reviewer_cannot_open_order' }), NITISH))
    assert.match(html, /Operations reviewer cannot open this Order/)
    assert.match(html, /an admin, a member of the operations team, or a holder of orders\.view_all/)
    assert.doesNotMatch(html, /<button/)
  })

  test('accepted: who and when, the Order aligned against this version, and only Withdraw acceptance', () => {
    const html = card(view(handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-21T09:00:00Z', accepted_note: 'Can proceed' }), NITISH))
    assert.match(html, /Accepted for production/)
    assert.match(html, /by Nitish · on 2026-09-21/)
    assert.match(html, /Can proceed/)
    assert.match(html, /Aligned · PI V1/)
    assert.match(html, /<button[^>]*>Withdraw acceptance/)
    assert.doesNotMatch(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
  })

  test('flagged: the reason, not aligned, and only Accept remains for the reviewer', () => {
    const html = card(view(handoff({ status: 'clarification_needed', clarification_by: NITISH, clarification_at: '2026-09-21T09:00:00Z', clarification_reason: 'Which fabric?' }), NITISH))
    assert.match(html, /Clarification needed/)
    assert.match(html, /Which fabric\?/)
    assert.match(html, /PI V1 flagged for clarification/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
    assert.doesNotMatch(html, /<button[^>]*>Withdraw/)
  })

  test('withdrawn: the earlier acceptance is still on record beside the withdrawal', () => {
    const html = card(view(handoff({
      status: 'clarification_needed',
      accepted_by: NITISH, accepted_at: '2026-09-21T09:00:00Z', accepted_note: null,
      acceptance_withdrawn_by: NITISH, acceptance_withdrawn_at: '2026-09-22T09:00:00Z', acceptance_withdrawn_reason: 'Qty wrong',
      clarification_by: NITISH, clarification_at: '2026-09-22T09:00:00Z', clarification_reason: 'Qty wrong',
    }), NITISH))
    assert.match(html, /Accepted earlier by Nitish · on 2026-09-21/)
    assert.match(html, /withdrawn by Nitish · on 2026-09-22/)
    assert.match(html, /Qty wrong/)
    assert.match(html, /Not Aligned/)
  })

  test('a revised workbook: the reason, both Open buttons, and no comparison claimed', () => {
    const v2 = handoff({ id: 'h2', version_number: 2, pi_version_id: 'v2', prior_handoff_status: 'accepted', approved_at: '2026-09-22T10:00:00Z', production_alignment_at_approval: 'aligned' })
    const html = card(view(v2, NITISH, { revisionReason: 'Client changed the fabric' }), {
      history: [handoff({ status: 'accepted', accepted_by: NITISH, accepted_at: '2026-09-21T09:00:00Z', superseded_at: '2026-09-22T10:00:00Z', superseded_by_version_id: 'v2' })],
      current: version(2, 'approved', 'Client changed the fabric'),
      previous: version(1, 'superseded'),
    })
    assert.match(html, /PI V2/)
    assert.match(html, /Revised because: /)
    assert.match(html, /Client changed the fabric/)
    assert.match(html, /<button[^>]*>Open current PI \(V2\)/)
    assert.match(html, /<button[^>]*>Open previous PI \(V1\)/)
    assert.match(html, /field-by-field comparison .* is not available yet/)
    assert.doesNotMatch(html, /href=/, 'no URL is built into the markup; the page signs on the press')
    assert.match(html, /An earlier version was accepted for production\. PI V2 has not been\./)
    assert.match(html, /Production was aligned before PI V2 .* has been reset/)
    assert.match(html, /Earlier versions \(1\)/)
    assert.match(html, /PI V1: Accepted for production/)
    assert.match(html, /<button[^>]*>Accept for production/)
  })

  test('not recorded: an honest absence, no controls, no invented acceptance', () => {
    const html = card(view(null, NITISH))
    assert.match(html, /Not recorded/)
    assert.match(html, /approved before operations handoffs were recorded/)
    assert.doesNotMatch(html, /<button/)
    assert.doesNotMatch(html, /Accepted for production/)
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

  test('Nitish sees the historic approval, "Awaiting operations review", and BOTH decisions', () => {
    const html = card(view(late, NITISH))
    assert.match(html, /Awaiting operations review/)
    assert.match(html, /Approved by Nishant · on 2026-09-21/, 'the approval keeps its own date, not the handoff\'s')
    assert.match(html, /Operations reviewer<\/dt><dd[^>]*><span[^>]*>Nitish<\/span>/)
    assert.match(html, /<button[^>]*>Accept for production/)
    assert.match(html, /<button[^>]*>Cannot accept/)
  })

  test('Nishant, the approving admin, sees the status and no decision', () => {
    const html = card(view(late, NISHANT))
    assert.match(html, /Awaiting operations review/)
    assert.match(html, /Operations reviewer<\/dt><dd[^>]*><span[^>]*>Nitish<\/span>/)
    assert.doesNotMatch(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
    assert.match(html, /Only the assigned operations reviewer can accept/)
  })

  test('any other admin sees no decision either', () => {
    const html = card(view(late, OTHER_ADMIN))
    assert.doesNotMatch(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
  })

  test('an admin VIEWING AS Nitish is not lent his decision', () => {
    const html = card(view(late, null, { viewingAs: true }))
    assert.doesNotMatch(html, /<button[^>]*>Accept for production/)
    assert.doesNotMatch(html, /<button[^>]*>Cannot accept/)
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

  test('a skeleton, not a Not recorded claim, until handoffReady', () => {
    assert.match(body, /\{!handoffReady \? \(\s*<SectionSkeleton rows=\{2\} label="Loading operations review" \/>\s*\) : operationsView && \(\s*<OrderOperationsReviewCard/)
  })

  test('no header Align button on a handoff Order; the legacy Order keeps it', () => {
    assert.match(page, /alignAction: operationsSplit\.live \? null : production\?\.action \? \(productionAligned \? 'unalign' : 'align'\) : null/)
  })

  test('the Production summary row names the version and the acceptance behind the alignment', () => {
    assert.match(page, /productionLabel: handoffAlignment\?\.label \?\? production\?\.label \?\? '—'/)
    assert.match(page, /productionLine: handoffAlignment \? handoffAlignment\.line : \(production\?\.line \?\? null\)/)
  })

  test('the card gets the revision reason and the two versions, opened through the page\'s signer', () => {
    assert.match(page, /revisionReason: piHistory\.current\?\.revisionReason \?\? null/)
    assert.match(body, /currentVersion=\{piHistory\.current\}/)
    assert.match(body, /previousVersion=\{previousPiVersion\}/)
    assert.match(body, /onOpenVersion=\{v => \{ void openVersionFile\(v, 'view'\) \}\}/)
    assert.match(body, /withdrawing=\{handoffDialog === 'clarification_needed' && operationsView\.status === 'accepted'\}/)
  })

  test('a decision re-reads the handoff AND the Order row, because acceptance moves the alignment columns', () => {
    const fn = page.slice(page.indexOf('const decideHandoff'), page.indexOf('const decideHandoff') + 2200)
    assert.match(fn, /await Promise\.all\(\[reloadHandoffs\(\), reloadOrderRow\(\)\]\)/)
    assert.doesNotMatch(fn, /loadOrder\(\)/)
  })
})
