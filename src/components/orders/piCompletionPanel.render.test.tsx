/**
 * PI DETAILS AND THE SUBMIT CARD, ACTUALLY RENDERED — the grouped facts, the
 * Submit card's lines and control, and the locked state.
 *
 * Static markup cannot press a button, so behaviour that needs a press is held
 * two ways: each state is drawn from props (the states are real states, arrived
 * at the way the page arrives at them), and the page's wiring is read from its
 * source. The whole thing was also driven in a browser against a local stack —
 * see the PR description.
 *
 * Run:
 *   npx tsx --test src/components/orders/piCompletionPanel.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  COMPLETION_LOCKED_CHIP,
  COMPLETION_LOCKED_HINT,
  COMPLETION_LOCKED_SUBTITLE,
  COMPLETION_LOCKED_TITLE,
  COMPLETION_SUBTITLE,
  COMPLETION_TITLE,
  PiCompletionFacts,
  PiCompletionPanel,
  PiLockedNotice,
  PiSubmitCard,
} from './PiCompletionPanel'
import {
  PI_LOCKED_TITLE,
  buildCompletionFacts,
  buildSubmitChecks,
  describeLockedNotice,
  type LockedViewer,
  type CompletionItem,
} from '@/lib/orders/piCompletion'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const noop = () => {}

const item = (over: Partial<CompletionItem> & { key: string; label: string }): CompletionItem =>
  ({ need: 'submission', where: 'client', ...over })

describe('the Submit card: one line per part of the PI, then the control (owner, 2026-10-30)', () => {
  const missing = [
    item({ key: 'client_city', label: 'Client city' }),
    item({ key: 'order_details:due_date', label: 'Dispatch Date Finalized', where: 'internal', field: 'due_date' }),
    item({ key: 'source_workbook', label: 'The uploaded PI workbook', where: 'workbook', needsReimport: true }),
    item({ key: 'product_lines_incomplete', label: '2 product lines are missing a name', where: 'products' }),
  ]
  const optional = [item({ key: 'documents:client_po', label: 'Client PO', need: 'optional', where: 'documents' })]
  const advance = { met: false, receivedPercent: '13.18%', standard: '40%' }
  const checks = (over: Partial<Parameters<typeof buildSubmitChecks>[0]> = {}) => buildSubmitChecks({
    completion: { requiredMissing: missing, optionalMissing: optional }, blockingCount: 0, advance, ...over,
  })
  const draw = (over: Partial<Parameters<typeof PiSubmitCard>[0]> = {}) => renderToStaticMarkup(
    <PiSubmitCard checks={checks()} onFix={noop} disabled={false}
      submit={{ label: 'Submit for Approval', disabled: true, reason: 'Needed to submit: Client city', onSubmit: noop }}
      onChangePi={noop} {...over} />)

  test('the lines are grouped by where each item is filled in, from the same lists the sections mark', () => {
    const lines = checks()
    assert.deepEqual(lines.map(l => l.key), ['client', 'details', 'products', 'supporting', 'advance'])
    assert.deepEqual(lines.map(l => l.state), ['need', 'need', 'need', 'optional', 'need'])
    assert.equal(lines[0].text, 'Client city is needed')
    assert.equal(lines[1].text, 'Dispatch Date Finalized is needed')
    assert.equal(lines[2].text, 'The uploaded PI workbook and 2 product lines are missing a name are needed')
    assert.equal(lines[3].text, 'Optional — you will be asked once when you submit')
    assert.equal(lines[4].label, 'Advance 13.18%')
    assert.equal(lines[4].text, 'Below 40% — give the reason when you submit')
  })

  test('a clean PI: Client and Order details complete, no products line, supporting all added, the advance reached', () => {
    const lines = buildSubmitChecks({ completion: { requiredMissing: [], optionalMissing: [] }, blockingCount: 0, advance: { ...advance, met: true } })
    assert.deepEqual(lines.map(l => [l.key, l.state, l.text]), [
      ['client', 'ok', 'Complete'],
      ['details', 'ok', 'Complete'],
      ['supporting', 'ok', 'All added'],
      ['advance', 'ok', '40% reached'],
    ])
  })

  test('workbook issues are one products line, with nothing to press', () => {
    const line = buildSubmitChecks({ completion: { requiredMissing: [], optionalMissing: [] }, blockingCount: 2, advance: null })
      .find(l => l.key === 'products')
    assert.equal(line?.text, 'Fix the issues in the PI first')
    assert.equal(line?.fix, null)
  })

  test('no advance line while the summary is unread', () => {
    assert.ok(!checks({ advance: null }).some(l => l.key === 'advance'))
  })

  test('"Add" goes to the first item a form can fix — never one only a corrected workbook can', () => {
    const lines = checks()
    assert.equal(lines[0].fix?.key, 'client_city')
    assert.equal(lines[1].fix?.key, 'order_details:due_date')
    assert.equal(lines[2].fix?.key, 'product_lines_incomplete', 'the workbook item is skipped for the one Edit PI can fix')
    const html = draw()
    assert.equal((html.match(/class="pi-submit-check-fix"/g) ?? []).length, 3)
    assert.ok(!draw({ onFix: null }).includes('pi-submit-check-fix'), 'a viewer who cannot edit gets the names as plain text')
    assert.ok(/<button[^>]*class="pi-submit-check-fix"[^>]*disabled=""/.test(draw({ disabled: true })) ||
      /<button[^>]*disabled=""[^>]*class="pi-submit-check-fix"/.test(draw({ disabled: true })), 'disabled while a write is in flight')
  })

  test('Submit is full width under the lines, disabled with its reason said under it; Change PI is the quiet control last', () => {
    const html = draw()
    assert.ok(html.indexOf('pi-submit-checks') < html.indexOf('pi-submit-button'))
    assert.ok(/<button[^>]*class="boe-btn boe-btn-primary pi-submit-button"[^>]*disabled=""/.test(html))
    assert.ok(text(html).includes('Needed to submit: Client city.'))
    const buttons = [...html.matchAll(/<button[^>]*class="boe-btn[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]))
    assert.deepEqual(buttons, ['Submit for Approval', 'Change PI'])
  })

  test('a complete PI says nothing under Submit, and Submit is live', () => {
    const html = draw({ submit: { label: 'Submit for Approval', disabled: false, reason: null, onSubmit: noop } })
    assert.ok(!html.includes('pi-submit-reason'))
    assert.ok(!/<button[^>]*pi-submit-button[^>]*disabled/.test(html))
  })

  test('a resubmission is offered the same control under its own label, as the card’s title too', () => {
    const t = text(draw({ submit: { label: 'Resubmit for Approval', disabled: false, reason: null, onSubmit: noop } }))
    assert.equal((t.match(/Resubmit for Approval/g) ?? []).length, 2)
  })
})

describe('the client facts', () => {
  const facts = buildCompletionFacts({
    client_name: 'Kalyan', client_city: null, bill_to_phone: null,
    billing_address: 'A very long billing address line that has to wrap inside its own value area, 12/B Some Road, Coimbatore',
  })
  const render = (over: { canEdit?: boolean; locked?: boolean } = {}) =>
    renderToStaticMarkup(<PiCompletionFacts title="Client" facts={facts} editLabel="Edit client details"
      canEdit={over.canEdit ?? true} locked={over.locked ?? false} onEdit={noop} />)

  test('five facts: name, city and phone, then the two addresses — no salesperson contact, no PI terms', () => {
    const html = render()
    assert.deepEqual([...html.matchAll(/data-fact="([a-z_]+)"/g)].map(m => m[1]), ['client_name', 'client_city', 'bill_to_phone', 'billing_address', 'shipping_address'])
    const t = text(html)
    for (const gone of ['Salesperson contact number', 'PI terms', 'Date of creation', 'Commercial terms']) assert.ok(!t.includes(gone), gone)
  })

  test('each fact is a label with its value beside it; only the ones Submit needs carry a red star', () => {
    const html = render()
    const t = text(html)
    assert.ok(t.includes('Client name') && t.includes('Kalyan'))
    assert.ok(/<dt>Client name<span[^>]*pi-form-req/.test(html) && /<dt>Client city<span[^>]*pi-form-req/.test(html))
    assert.equal((html.match(/pi-form-req/g) ?? []).length, 2)
    assert.ok(t.includes('Not added yet'), 'a missing required value is said in words, not left blank')
    assert.ok(t.includes('Not given'), 'a missing optional one is said too')
    assert.ok(/<dd data-empty="true" data-required="true">Not added yet<\/dd>/.test(html))
    assert.ok(t.includes('12/B Some Road, Coimbatore'), 'a long address is shown whole, to be wrapped by CSS')
  })

  test('one edit control, and it is live for somebody who may edit', () => {
    const html = render()
    assert.equal((html.match(/<button/g) ?? []).length, 1)
    assert.ok(!/<button[^>]*disabled/.test(html))
  })

  test('locked: the control stays, muted and disabled, with the reason; every value stays legible', () => {
    const html = render({ locked: true })
    assert.ok(/<button[^>]*disabled=""/.test(html))
    assert.ok(html.includes(COMPLETION_LOCKED_HINT))
    assert.ok(text(html).includes('Kalyan'))
  })

  test('a viewer who may not edit is not offered a control at all', () => {
    assert.ok(!render({ canEdit: false }).includes('<button'))
  })
})

describe('the PI details card: a title row, then the sections', () => {
  const groups = <div data-testid="groups">fields</div>
  const draw = (over: Partial<Parameters<typeof PiCompletionPanel>[0]> = {}) => renderToStaticMarkup(
    <PiCompletionPanel mode="complete" neededCount={0} groups={groups} {...over} />)

  test('for whoever can submit: titled, what it is for, and how much Submit still needs', () => {
    const html = draw({ neededCount: 2 })
    assert.ok(html.includes(`aria-label="${COMPLETION_TITLE}"`) && html.includes('data-locked="false"'))
    assert.ok(text(html).includes(COMPLETION_SUBTITLE))
    assert.ok(text(html).includes('2 needed to submit'))
    assert.ok(text(draw()).includes('Ready to submit'))
    assert.ok(html.indexOf('pi-completion-head') < html.indexOf('data-testid="groups"'))
  })

  test('the Submit control is no longer here — it is the Submit card’s, beside the payment', () => {
    assert.ok(!draw().includes('<button'))
    assert.ok(!draw().includes('pi-completion-actions'))
  })

  test('locked: what Sales submitted, marked locked — and the fields are still there', () => {
    const html = draw({ mode: 'locked' })
    assert.ok(html.includes(`aria-label="${COMPLETION_LOCKED_TITLE}"`) && html.includes('data-locked="true"'))
    assert.ok(text(html).includes(COMPLETION_LOCKED_SUBTITLE) && text(html).includes(COMPLETION_LOCKED_CHIP))
    assert.ok(!text(html).includes('needed to submit'))
    assert.ok(html.includes('data-testid="groups"'))
  })

  test('anybody else: the same card, read-only, with no status', () => {
    const html = draw({ mode: 'read', neededCount: 3 })
    assert.ok(!html.includes('pi-chip'))
    assert.ok(html.includes('data-testid="groups"'))
  })

  test('the page draws Client, Order details and Supporting details inside the one card (owner, 2026-10-30)', () => {
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    const at = page.indexOf('<PiCompletionPanel')
    const body = page.slice(at, page.indexOf('<div className="pi-zone-rail">'))
    assert.ok(body.indexOf('title="Client"') < body.indexOf('<PiOrderDetailsSection'))
    assert.ok(body.indexOf('<PiOrderDetailsSection') < body.indexOf('{supportingDetails}'))
    assert.ok(!body.includes('PI terms') && !body.includes('Edit PI terms'))
    assert.ok(page.includes("mode={actions.canSubmit ? 'complete' : isLocked ? 'locked' : 'read'}"), 'one card for every viewer')
  })

  test('each section carries its own status beside its title', () => {
    const facts = buildCompletionFacts({ client_name: 'Kalyan', client_city: 'Pune' })
    const html = renderToStaticMarkup(<PiCompletionFacts title="Client" facts={facts} editLabel="Edit client details"
      canEdit locked={false} onEdit={noop} chip={<span className="pi-chip">Complete</span>} />)
    assert.ok(html.indexOf('Client') < html.indexOf('pi-chip') && html.indexOf('pi-chip') < html.indexOf('<button'))
  })
})

const viewer = (over: Partial<LockedViewer> = {}): LockedViewer =>
  ({ ownsSubmission: false, canAdminAmend: false, canEdit: false, canReview: false, canAddPayment: false, ...over })
const OWNER = describeLockedNotice(viewer({ ownsSubmission: true }))

describe('the locked notice', () => {
  test('is a status, says what it means, and gives the owner the one route back', () => {
    const html = renderToStaticMarkup(<PiLockedNotice title={PI_LOCKED_TITLE} body={OWNER} onRequestChange={noop} />)
    assert.ok(html.includes('role="status"') && html.includes('data-testid="pi-locked-notice"'))
    assert.ok(text(html).includes('Submitted — this PI is locked'))
    assert.ok(text(html).includes('You cannot edit this PI while it is with management. You can request a change from management.'))
    assert.deepEqual([...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1])), ['Request change'])
  })

  test('for anybody who cannot ask, it says so and offers nothing to press', () => {
    const html = renderToStaticMarkup(<PiLockedNotice title={PI_LOCKED_TITLE} body={describeLockedNotice(viewer())} onRequestChange={null} />)
    assert.ok(!html.includes('<button'))
    assert.ok(text(html).includes('with management for review'))
  })

  test('the owner is told they cannot edit and may request a change — and nothing they cannot do', () => {
    assert.equal(OWNER, 'You cannot edit this PI while it is with management. You can request a change from management.')
  })

  test('an administrator is told the amendment route that still exists, with its reason — not that nothing can be done', () => {
    const admin = describeLockedNotice(viewer({ canAdminAmend: true, canReview: true }))
    assert.ok(admin.includes('you can still amend it from Edit PI, with a reason'))
    assert.ok(admin.includes('approve it, send it back for changes, or reject it'))
    assert.ok(!admin.includes('request a change'), 'an admin amends; they do not ask')
    // The owner who is also an admin is told the admin truth, not the owner's.
    assert.equal(describeLockedNotice(viewer({ ownsSubmission: true, canAdminAmend: true })).includes('cannot edit this PI'), false)
  })

  test('management that is not an admin can decide but is told it cannot edit', () => {
    const reviewer = describeLockedNotice(viewer({ canReview: true }))
    assert.ok(reviewer.includes('you cannot edit it') && reviewer.includes('approve it, send it back for changes, or reject it'))
    assert.ok(!reviewer.includes('Edit PI') && !reviewer.includes('request a change'))
  })

  test('somebody with no rights but to read is told so', () => {
    const reader = describeLockedNotice(viewer())
    assert.ok(reader.includes('you cannot edit it') && reader.includes('read it'))
    assert.ok(!reader.includes('approve') && !reader.includes('Edit PI') && !reader.includes('payments'))
  })

  test('Add payment is said, separately and only to somebody who may do it — and it is never described as an edit of the PI', () => {
    for (const v of [viewer({ ownsSubmission: true }), viewer({ canAdminAmend: true }), viewer({ canReview: true }), viewer()]) {
      assert.ok(!describeLockedNotice(v).includes('payments'))
      const paying = describeLockedNotice({ ...v, canAddPayment: true })
      assert.ok(paying.endsWith('You can still add payments; that does not edit the PI.'), paying)
    }
  })

  test('every clause follows a right the page already resolved — no clause without its input', () => {
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(page.includes('describeLockedNotice({ ownsSubmission, canAdminAmend, canEdit: canEditSubmission, canReview, canAddPayment })'))
    assert.ok(page.includes('isLocked && !canEditSubmission && !canAdminAmend && ownsSubmission'), 'Request change follows the same rule the sentence does')
  })
})

describe('the middleman commission is one editable item', () => {
  test('on the page: the summary carries no commission row at all, and Internal order details is the only editor', () => {
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    assert.ok(!page.includes('PiCommissionSummary'), 'no repeat of the answer beside Product value and Total before GST')
    assert.ok(!page.includes('internal={'), 'the commercial card is given no commission block')
    assert.equal((page.match(/<PiOrderDetailsSection/g) ?? []).length, 1, 'the one form, drawn once in the PI details card')
    assert.ok(!page.includes('internalSubmitBlock &&'), 'the middleman warning above the Submit dialog is gone')
    assert.ok(!page.includes('SUBMISSION_MIDDLEMAN_HINT'))
  })
})

describe('the page wiring', () => {
  const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
  const sections = read('src/app/orders/drafts/[submissionId]/piDetailSections.tsx')

  test('the card is drawn for everybody; Submit only for whoever can submit', () => {
    assert.ok(page.includes("const isLocked = submission.status === 'submitted'"))
    assert.equal((page.match(/<PiCompletionPanel/g) ?? []).length, 1)
    assert.ok(/\{actions\.canSubmit && \(\s*<PiSubmitCard/.test(page))
    // The workflow panel still draws no owner controls of its own on this page.
    assert.ok(page.includes('const showCompletion = actions.canSubmit || isLocked'))
    assert.ok(page.includes('ownerActionsElsewhere={showCompletion}'))
  })

  test('the lock only DRAWS: no write, no permission and no RPC reads it — the database decides', () => {
    for (const drawn of ['isLocked', 'showCompletion']) {
      const uses = [...page.matchAll(new RegExp(`.*\\b${drawn}\\b.*`, 'g'))].map(m => m[0])
      for (const line of uses) assert.ok(!/supabase\.rpc|\.from\(/.test(line), `${drawn} must not gate a write: ${line.trim()}`)
    }
    assert.ok(!/canEditSubmission\s*=\s*.*isLocked/.test(page), 'the server answer is not overridden by the screen')
    assert.ok(page.includes("supabase.rpc('can_edit_order_submission'"), 'the editing authority is still asked of the database')
  })

  test('management keeps its own decisions on a locked PI', () => {
    // The reviewer controls are drawn from actions.canRequestChanges / canReject and are not conditioned on the lock.
    const reviewer = sections.slice(sections.indexOf('{isReviewer && ('), sections.indexOf('{isReviewer && (') + 400)
    assert.ok(!/ownerActionsElsewhere|isLocked/.test(reviewer))
    assert.ok(sections.includes('const ownerActions = (actions.canSubmit || actions.canChangePi) && !ownerActionsElsewhere'))
  })

  test('Request change is the existing correction route, offered on a locked PI to its owner', () => {
    assert.ok(page.includes('isLocked && !canEditSubmission && !canAdminAmend && ownsSubmission'))
    assert.ok(page.includes('sendCorrectionRequest'))
    assert.ok(read('src/components/orders/piReviewModals.tsx').includes("supabase.rpc") === false, 'the modal itself writes nothing')
    assert.ok(page.includes("supabase.rpc('request_order_submission_correction'"))
  })

  test('the header Edit PI is still governed by the same rule — it is not shown for a locked PI to its owner', () => {
    assert.ok(page.includes('const mayEditPi = (canEditSubmission || canAdminAmend) && !piIsOrder'))
  })

  test('Add payment does not depend on the lock, and the lock does not depend on Add payment', () => {
    // Recording a payment is Finance data, not an edit of the PI.
    const rule = page.slice(page.indexOf('const canAddPayment = canAddPiPayment('), page.indexOf('const canAddPayment = canAddPiPayment(') + 900)
    assert.ok(!/isLocked|showCompletion/.test(rule), 'the payment rule is its own')
    assert.ok(page.includes('canAdd={canAddPayment}'))
    // The shared rule admits a submitted PI (and refuses an approved, rejected or Order-bound one).
    const view = read('src/lib/finance/piPaymentView.ts')
    const fn = view.slice(view.indexOf('export function canAddPiPayment'), view.indexOf('export function canAddPiPayment') + 800)
    assert.ok(fn.includes("pi.status === 'approved' || pi.status === 'rejected'") && !fn.includes("'submitted'"))
    assert.ok(!/canEditSubmissions*=s*.*canAddPayment|canAddPayment.*canEditSubmission =/.test(page), 'and it grants no edit')
    // While locked, the payment write goes through the payment RPC, never a PI edit door.
    assert.ok(page.includes('recordPiPayment(supabase, submissionId, form, key)'))
  })

  test('the Submit sequence is opened by one function, and sent by the one existing door', () => {
    assert.equal((page.match(/function openSubmit\(\)/g) ?? []).length, 1)
    assert.ok(page.includes('onSubmit: openSubmit'))
    assert.equal((page.match(/supporting\.send\(/g) ?? []).length, 1)
  })
})
