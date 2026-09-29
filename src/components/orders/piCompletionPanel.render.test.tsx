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
  COMPLETION_READY_TEXT,
  COMPLETION_TITLE,
  PiCompletionChecklist,
  PiCompletionFacts,
  PiCompletionPanel,
  PiLockedNotice,
} from './PiCompletionPanel'
import { PiCommissionSummary } from './PiInternalDetails'
import {
  PI_LOCKED_ADMIN_BODY,
  PI_LOCKED_OWNER_BODY,
  PI_LOCKED_TITLE,
  PI_LOCKED_VIEWER_BODY,
  buildCompletionFacts,
  type CompletionItem,
  type PiCompletion,
} from '@/lib/orders/piCompletion'
import { formatIsoDay } from '@/lib/orders/piInternalDetails'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
const noop = () => {}

const item = (over: Partial<CompletionItem> & { key: string; label: string }): CompletionItem =>
  ({ need: 'submission', where: 'client', ...over })
const completion = (over: Partial<PiCompletion> = {}): PiCompletion => ({
  requiredMissing: [], laterMissing: [], optionalMissing: [], readyToSubmit: true, ...over,
})

describe('the live checklist', () => {
  const missing = completion({
    requiredMissing: [
      item({ key: 'client_city', label: 'Client city' }),
      item({ key: 'order_details:due_date', label: 'Dispatch Date Finalized', where: 'internal', field: 'due_date' }),
      item({ key: 'source_workbook', label: 'The uploaded PI workbook', where: 'workbook', needsReimport: true }),
      item({ key: 'product_lines_incomplete', label: '2 product lines are missing a name', where: 'products' }),
    ],
    laterMissing: [item({ key: 'salesperson_id', label: 'Salesperson', need: 'later', where: 'internal' }), item({ key: 'lead_source', label: 'Lead source', need: 'later', where: 'internal' })],
    optionalMissing: [item({ key: 'documents:client_po', label: 'Client PO', need: 'optional', where: 'documents' }), item({ key: 'order_highlight', label: 'Order highlight', need: 'optional', where: 'highlight' })],
    readyToSubmit: false,
  })
  const html = renderToStaticMarkup(<PiCompletionChecklist completion={missing} onFix={noop} disabled={false} />)
  const t = text(html)

  test('names every required item, with a count, and says Submit waits for them', () => {
    assert.ok(t.includes('4 required items left'))
    assert.ok(t.includes('Submit for approval waits for these'))
    for (const label of ['Client city', 'Dispatch Date Finalized', 'The uploaded PI workbook']) assert.ok(t.includes(label), label)
  })

  test('a required item a form can fix has Add; a workbook problem says so and offers Change PI; a counted product line has nothing to press', () => {
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]))
    assert.deepEqual(buttons, ['Add', 'Add', 'Change PI'])
    assert.ok(t.includes('a corrected workbook is needed'))
  })

  test('later and optional items are named, and labelled as such — never as a demand', () => {
    assert.ok(t.includes('Required later to create the Order') && t.includes('Not needed to submit: Salesperson and Lead source.'))
    assert.ok(t.includes('Optional') && t.includes('Not filled: Client PO and Order highlight.'))
  })

  test('nothing missing: one green line, and no list', () => {
    const ready = text(renderToStaticMarkup(<PiCompletionChecklist completion={completion()} onFix={noop} disabled={false} />))
    assert.ok(ready.includes(COMPLETION_READY_TEXT))
    assert.ok(!ready.includes('required item'))
  })

  test('a single item reads in the singular', () => {
    const one = text(renderToStaticMarkup(<PiCompletionChecklist completion={completion({ requiredMissing: [item({ key: 'client_city', label: 'Client city' })], readyToSubmit: false })} onFix={noop} disabled={false} />))
    assert.ok(one.includes('1 required item left'))
  })

  test('with no way to fix (a viewer who cannot edit) nothing is offered to press', () => {
    const none = renderToStaticMarkup(<PiCompletionChecklist completion={missing} onFix={null} disabled={false} />)
    assert.ok(!none.includes('<button'))
  })

  test('while a write is in flight, Add is disabled', () => {
    const busy = renderToStaticMarkup(<PiCompletionChecklist completion={missing} onFix={noop} disabled />)
    assert.ok(/<button[^>]*disabled=""[^>]*>Add<\/button>/.test(busy))
  })
})

describe('the grouped facts', () => {
  const facts = buildCompletionFacts({
    client_name: 'Kalyan', client_city: null, contact_number: '9999999999', bill_to_phone: null,
    creation_date: '2026-09-20', source_created_by: 'Dhruv', commercial_terms_note: 'Standard terms.',
  }, formatIsoDay)
  const render = (over: { canEdit?: boolean; locked?: boolean } = {}) =>
    renderToStaticMarkup(<PiCompletionFacts title="Client" facts={facts.filter(f => f.group === 'client')} editLabel="Edit client details"
      canEdit={over.canEdit ?? true} locked={over.locked ?? false} onEdit={noop} />)

  test('every field shows its current value and its label: Required for submission or Optional', () => {
    const t = text(render())
    assert.ok(t.includes('Client name') && t.includes('Kalyan'))
    assert.ok(t.includes('Required for submission') && t.includes('Optional'))
    assert.ok(t.includes('Not added yet'), 'a missing required value is said in words, not left blank')
    assert.ok(t.includes('Not given'), 'a missing optional one is said too')
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

describe('the area: checklist above the fields, the action last', () => {
  const groups = <div data-testid="groups">fields</div>
  const draw = (over: Partial<Parameters<typeof PiCompletionPanel>[0]> = {}) => renderToStaticMarkup(
    <PiCompletionPanel completion={completion()} locked={false} checklistDisabled={false} onFix={noop} groups={groups}
      submit={{ label: 'Submit for Approval', disabled: false, reason: null, onSubmit: noop }}
      onChangePi={noop} requestChange={null} {...over} />)

  test('open: titled, checklist first, fields, then Change PI and Submit — in that order', () => {
    const html = draw()
    assert.ok(html.includes(`aria-label="${COMPLETION_TITLE}"`) && html.includes('data-locked="false"'))
    assert.ok(html.indexOf('pi-completion-checklist') < html.indexOf('data-testid="groups"'))
    assert.ok(html.indexOf('data-testid="groups"') < html.indexOf('pi-completion-actions'))
    const actions = [...html.slice(html.indexOf('pi-completion-actions')).matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]))
    assert.deepEqual(actions, ['Change PI', 'Submit for Approval'])
  })

  test('Submit is blocked, with the reason beside it, while a required item is missing', () => {
    const html = draw({
      completion: completion({ requiredMissing: [item({ key: 'client_city', label: 'Client city' })], readyToSubmit: false }),
      submit: { label: 'Submit for Approval', disabled: true, reason: '1 required item is still missing', onSubmit: noop },
    })
    assert.ok(/<button[^>]*disabled=""[^>]*>[\s\S]*?Submit for Approval<\/button>/.test(html))
    assert.equal(html.match(/data-testid="pi-submit-reason"[^>]*>([^<]*)</)?.[1], '1 required item is still missing')
  })

  test('optional and later items never disable it', () => {
    const html = draw({ completion: completion({ optionalMissing: [item({ key: 'order_highlight', label: 'Order highlight', need: 'optional', where: 'highlight' })], laterMissing: [item({ key: 'lead_source', label: 'Lead source', need: 'later' })] }) })
    assert.ok(!/<button[^>]*disabled=""[^>]*>[\s\S]*?Submit for Approval<\/button>/.test(html))
  })

  test('a resubmission is offered the same control under its own label', () => {
    assert.ok(text(draw({ submit: { label: 'Resubmit for Approval', disabled: false, reason: null, onSubmit: noop } })).includes('Resubmit for Approval'))
  })

  test('locked: retitled, no checklist, no Submit, no Change PI — and the fields are still there', () => {
    const html = draw({ locked: true, submit: null, onChangePi: null })
    assert.ok(html.includes(`aria-label="${COMPLETION_LOCKED_TITLE}"`) && html.includes('data-locked="true"'))
    assert.ok(text(html).includes(COMPLETION_LOCKED_HINT))
    assert.ok(!html.includes('pi-completion-checklist'))
    assert.ok(!html.includes('pi-completion-actions'), 'no edit, upload or save action of any kind')
    assert.ok(html.includes('data-testid="groups"'))
  })
})

describe('the locked notice', () => {
  test('is a status, says what it means, and gives the owner the one route back', () => {
    const html = renderToStaticMarkup(<PiLockedNotice title={PI_LOCKED_TITLE} body={PI_LOCKED_OWNER_BODY} onRequestChange={noop} />)
    assert.ok(html.includes('role="status"') && html.includes('data-testid="pi-locked-notice"'))
    assert.ok(text(html).includes('Submitted — this PI is locked'))
    assert.ok(text(html).includes('You cannot edit this PI while it is with management. You can request a change from management.'))
    assert.deepEqual([...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1])), ['Request change'])
  })

  test('for anybody who cannot ask, it says so and offers nothing to press', () => {
    const html = renderToStaticMarkup(<PiLockedNotice title={PI_LOCKED_TITLE} body={PI_LOCKED_VIEWER_BODY} onRequestChange={null} />)
    assert.ok(!html.includes('<button'))
    assert.ok(text(html).includes('with management for review'))
  })

  test('an administrator is told the amendment route that still exists, not that nothing can be done', () => {
    assert.ok(PI_LOCKED_ADMIN_BODY.includes('Edit PI') && PI_LOCKED_ADMIN_BODY.includes('reason'))
  })
})

describe('the middleman commission is one editable item', () => {
  test('the summary in the commercial card reports the answer and nothing else — no form, warning or call to action', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary row={{ status: 'draft' }} canEdit onEdit={noop} summaryOnly />)
    assert.ok(text(html).includes('Middleman commission') && text(html).includes('Not answered'))
    assert.ok(!html.includes('<button'), 'no Enter / Edit control')
    assert.ok(!/Needed before review|role="status"|AlertTriangle/.test(html), 'no warning line')
    assert.ok(!html.includes('<input') && !html.includes('type="radio"'), 'no form')
  })

  test('the full summary — and its call to action — still exists for any screen that wants it', () => {
    const html = renderToStaticMarkup(<PiCommissionSummary row={{ status: 'draft' }} canEdit onEdit={noop} />)
    assert.ok(html.includes('<button') && /Needed before review/.test(html))
  })

  test('on the page: the commercial card reports it, and Internal order details is the only editor', () => {
    const page = read('src/app/orders/drafts/[submissionId]/page.tsx')
    const card = page.slice(page.indexOf('<PiCommissionSummary'), page.indexOf('<PiCommissionSummary') + 260)
    assert.ok(card.includes('summaryOnly'))
    assert.equal((page.match(/<PiCommissionSummary/g) ?? []).length, 1)
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

  test('the Submit sequence is opened by one function, and sent by the one existing door', () => {
    assert.equal((page.match(/function openSubmit\(\)/g) ?? []).length, 1)
    assert.ok(page.includes('onSubmit: openSubmit'))
    assert.equal((page.match(/supporting\.send\(/g) ?? []).length, 1)
  })
})
