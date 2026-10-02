/**
 * COMPLETE PI DETAILS, ACTUALLY RENDERED — the checklist, the grouped facts, the
 * Submit control, and the locked state.
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
  COMPLETION_LOCKED_HINT,
  COMPLETION_LOCKED_TITLE,
  COMPLETION_TITLE,
  PiCompletionFacts,
  PiCompletionPanel,
  PiLockedNotice,
} from './PiCompletionPanel'
import {
  PI_LOCKED_TITLE,
  buildCompletionFacts,
  describeLockedNotice,
  type LockedViewer,
  type CompletionItem,
} from '@/lib/orders/piCompletion'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const noop = () => {}

const item = (over: Partial<CompletionItem> & { key: string; label: string }): CompletionItem =>
  ({ need: 'submission', where: 'client', ...over })
describe('what stops Submit is named beside it — there is no banner and no checklist', () => {
  const missing = [
    item({ key: 'client_city', label: 'Client city' }),
    item({ key: 'order_details:due_date', label: 'Dispatch Date Finalized', where: 'internal', field: 'due_date' }),
    item({ key: 'source_workbook', label: 'The uploaded PI workbook', where: 'workbook', needsReimport: true }),
    item({ key: 'product_lines_incomplete', label: '2 product lines are missing a name', where: 'products' }),
  ]
  const groups = <div data-testid="groups">fields</div>
  const draw = (over: Partial<Parameters<typeof PiCompletionPanel>[0]> = {}) => renderToStaticMarkup(
    <PiCompletionPanel completion={{ requiredMissing: [] }} locked={false} checklistDisabled={false} onFix={noop} groups={groups}
      submit={{ label: 'Submit for Approval', disabled: false, reason: null, issues: false, onSubmit: noop }}
      onChangePi={noop} requestChange={null} {...over} />)
  const blocked = (over: Partial<Parameters<typeof PiCompletionPanel>[0]> = {}) => draw({
    completion: { requiredMissing: missing },
    submit: { label: 'Submit for Approval', disabled: true, reason: 'Needed to submit: Client city', issues: false, onSubmit: noop },
    ...over,
  })

  test('every missing required item is named beside Submit, and the ones a form can fix are pressable', () => {
    const t = text(blocked())
    assert.ok(t.includes('Needed to submit:'))
    for (const label of ['Client city', 'Dispatch Date Finalized', 'The uploaded PI workbook', '2 product lines are missing a name']) assert.ok(t.includes(label), label)
    assert.ok(t.includes('a corrected workbook is needed'))
    const reason = blocked().split('data-testid="pi-submit-reason"')[1]?.split('class="boe-btn')[0] ?? ''
    // the counted product line has nothing to press: Edit PI owns those rows
    assert.deepEqual([...reason.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1])), ['Client city', 'Dispatch Date Finalized', 'The uploaded PI workbook'])
  })

  test('none of the old completion notices is drawn', () => {
    const t = text(blocked())
    for (const gone of ['required item left', 'Submit for approval waits for these', 'Required later to create the Order', 'Not needed to submit', 'Optional', 'Required to submit for approval', 'Needed when the Order is created']) {
      assert.ok(!t.includes(gone), gone)
    }
    assert.ok(!blocked().includes('pi-completion-checklist'))
  })

  test('with no way to fix (a viewer who cannot edit) the names are plain text', () => {
    const html = blocked({ onFix: null })
    const reason = html.split('data-testid="pi-submit-reason"')[1]?.split('<button type="button" class="boe-btn')[0] ?? ''
    assert.ok(!reason.includes('<button'))
    assert.ok(text(reason).includes('Client city'))
  })

  test('while a write is in flight, the names are disabled', () => {
    assert.ok(/<button[^>]*disabled=""[^>]*>Client city<\/button>/.test(blocked({ checklistDisabled: true })))
  })

  test('issues in the PI are said beside Submit too', () => {
    const html = draw({ submit: { label: 'Submit for Approval', disabled: true, reason: 'Fix the issues in the PI first', issues: true, onSubmit: noop } })
    assert.ok(text(html).includes('Fix the issues in the PI first.'))
  })

  test('a complete PI says nothing at all beside Submit', () => {
    assert.ok(!draw().includes('pi-submit-reason'))
  })

  test('Submit is disabled with its reason while a required item is missing; optional and later items never disable it', () => {
    assert.ok(/<button[^>]*disabled=""[^>]*>[\s\S]*?Submit for Approval<\/button>/.test(blocked()))
    assert.ok(!/<button[^>]*disabled=""[^>]*>[\s\S]*?Submit for Approval<\/button>/.test(draw()))
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

describe('the area: fields, then the action last', () => {
  const groups = <div data-testid="groups">fields</div>
  const draw = (over: Partial<Parameters<typeof PiCompletionPanel>[0]> = {}) => renderToStaticMarkup(
    <PiCompletionPanel completion={{ requiredMissing: [] }} locked={false} checklistDisabled={false} onFix={noop} groups={groups}
      submit={{ label: 'Submit for Approval', disabled: false, reason: null, issues: false, onSubmit: noop }}
      onChangePi={noop} requestChange={null} {...over} />)

  test('open: titled, fields, then Change PI and Submit — in that order', () => {
    const html = draw()
    assert.ok(html.includes(`aria-label="${COMPLETION_TITLE}"`) && html.includes('data-locked="false"'))
    assert.ok(html.indexOf('data-testid="groups"') < html.indexOf('pi-completion-actions'))
    const actions = [...html.slice(html.indexOf('pi-completion-actions')).matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]))
    assert.deepEqual(actions, ['Change PI', 'Submit for Approval'])
  })

  test('a resubmission is offered the same control under its own label', () => {
    assert.ok(text(draw({ submit: { label: 'Resubmit for Approval', disabled: false, reason: null, issues: false, onSubmit: noop } })).includes('Resubmit for Approval'))
  })

  test('locked: retitled, no Submit, no Change PI — and the fields are still there', () => {
    const html = draw({ locked: true, submit: null, onChangePi: null })
    assert.ok(html.includes(`aria-label="${COMPLETION_LOCKED_TITLE}"`) && html.includes('data-locked="true"'))
    assert.ok(!html.includes('pi-completion-actions'), 'no edit, upload or save action of any kind')
    assert.ok(html.includes('data-testid="groups"'))
  })

  test('the page draws Client, Supporting details, then Internal order details inside the one container', () => {
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    const at = page.indexOf('<PiCompletionPanel')
    const body = page.slice(at, at + 2600)
    assert.ok(body.indexOf('title="Client"') < body.indexOf('{supportingDetails}'))
    assert.ok(body.indexOf('{supportingDetails}') < body.indexOf('<PiOrderDetailsSection'))
    assert.ok(!body.includes('PI terms') && !body.includes('Edit PI terms'))
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
    assert.equal((page.match(/<PiOrderDetailsSection/g) ?? []).length, 2, 'the one form, drawn in either arrangement')
    assert.ok(!page.includes('internalSubmitBlock &&'), 'the middleman warning above the Submit dialog is gone')
    assert.ok(!page.includes('SUBMISSION_MIDDLEMAN_HINT'))
  })
})

describe('the page wiring', () => {
  const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
  const sections = read('src/app/orders/drafts/[submissionId]/piDetailSections.tsx')

  test('the area is drawn for whoever can submit, and — locked — for everybody', () => {
    assert.ok(page.includes('const showCompletion = actions.canSubmit || isLocked'))
    assert.ok(page.includes("const isLocked = submission.status === 'submitted'"))
    assert.equal((page.match(/<PiCompletionPanel/g) ?? []).length, 1)
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
