/**
 * The Phase A action rules: who may submit, replace, return or reject a saved
 * PI, and what anybody is told when it does not work.
 *
 * WHY THESE ARE WORTH TESTING. Every rule here is a rule about ABSENCE as much
 * as presence — a reviewer must not be offered Submit on somebody else's draft,
 * an owner must not be offered Reject on their own, a rejected record must offer
 * nothing at all, and no failure path may ever put a database message on screen.
 * Absence is exactly what stops being noticed on the third read of a JSX file.
 *
 * NONE OF THIS IS THE ACCESS CONTROL. The RPCs re-derive the actor, the
 * permission, the ownership and the status inside the database, under a row
 * lock, on every call. What is asserted here is that the SCREEN does not offer a
 * control the database would refuse — and, just as importantly, that it does not
 * hide one it would allow.
 *
 * Pure functions only. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionWorkflow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPROVE_DISABLED_REASON,
  CHANGE_PI_PARAM,
  RESUBMIT_NOTE_LABEL,
  RESUBMIT_NOTE_MAX_LENGTH,
  RESUBMIT_NOTE_PLACEHOLDER,
  submissionOffersReply,
  validateResubmitReply,
  NEEDS_CHANGES_NOTE_REQUIRED,
  REJECT_REASON_REQUIRED,
  SUBMIT_CONFIRM_NOTE,
  canReplaceSubmissionPi,
  changePiHref,
  describeSubmissionActions,
  describeSubmissionBanner,
  describeSubmissionFailure,
  readChangePiTarget,
  splitDraftsForReview,
  validateReviewNote,
  type SubmissionActionInput,
} from './submissionWorkflow'
import { describeDraftListEntry, formatSavedAt, type PersistedSubmission } from './draftsView'
import { formatInr } from '@/lib/pi/previewView'

const OWNER = '11111111-1111-4111-8111-111111111111'
const REVIEWER = '22222222-2222-4222-8222-222222222222'

const input = (over: Partial<SubmissionActionInput> = {}): SubmissionActionInput => ({
  status: 'draft',
  createdBy: OWNER,
  submittedBy: OWNER,
  viewerId: OWNER,
  canCreate: true,
  canApproveSubmission: false,
  ...over,
})

// ── The employee's own record ─────────────────────────────────────────────────

describe('what the owner of a saved PI may do', () => {
  test('a draft can be submitted and its PI replaced', () => {
    const actions = describeSubmissionActions(input())
    assert.equal(actions.isOwner, true)
    assert.equal(actions.canSubmit, true)
    assert.equal(actions.canChangePi, true)
    assert.equal(actions.isReadOnly, false)
  })

  test('a returned submission can be corrected and sent again', () => {
    const actions = describeSubmissionActions(input({ status: 'needs_changes' }))
    assert.equal(actions.canSubmit, true, 'resubmission is the whole point of Needs Changes')
    assert.equal(actions.canChangePi, true)
  })

  test('a submitted record is read-only to the person who submitted it', () => {
    const actions = describeSubmissionActions(input({ status: 'submitted' }))
    assert.equal(actions.canSubmit, false)
    assert.equal(actions.canChangePi, false, 'a reviewer must be reading a document that cannot move')
    assert.equal(actions.isReadOnly, true)
  })

  test('a rejected record offers its owner nothing at all', () => {
    const actions = describeSubmissionActions(input({ status: 'rejected' }))
    assert.deepEqual(
      [actions.canSubmit, actions.canChangePi, actions.canRequestChanges, actions.canReject, actions.canApprove],
      [false, false, false, false, false],
    )
    assert.equal(actions.isReadOnly, true)
  })

  test('an approved record is read-only too', () => {
    const actions = describeSubmissionActions(input({ status: 'approved' }))
    assert.equal(actions.canSubmit, false)
    assert.equal(actions.canChangePi, false)
  })

  test('withdrawing orders.create takes the controls away', () => {
    const actions = describeSubmissionActions(input({ canCreate: false }))
    assert.equal(actions.canSubmit, false, 'the RPC requires orders.create; the button must agree')
    assert.equal(actions.canChangePi, false, 'and so does the storage write policy')
  })

  test('the submitter counts as an owner even when somebody else created the row', () => {
    const actions = describeSubmissionActions(input({ createdBy: REVIEWER, submittedBy: OWNER }))
    assert.equal(actions.isOwner, true, 'the same pair can_edit_order_submission uses')
    assert.equal(actions.canSubmit, true)
  })

  test('a signed-out or unresolved viewer owns nothing', () => {
    for (const viewerId of [null, '']) {
      const actions = describeSubmissionActions(input({ viewerId }))
      assert.equal(actions.isOwner, false, 'a missing id must never match a null column')
      assert.equal(actions.canSubmit, false)
    }
  })

  test('a null created_by does not make an anonymous viewer the owner', () => {
    const actions = describeSubmissionActions(input({ createdBy: null, submittedBy: null, viewerId: null }))
    assert.equal(actions.isOwner, false)
  })
})

// ── The reviewer ──────────────────────────────────────────────────────────────

describe('what a holder of orders.approve_order may do', () => {
  const reviewer = (over: Partial<SubmissionActionInput> = {}) =>
    describeSubmissionActions(input({
      viewerId: REVIEWER, canCreate: false, canApproveSubmission: true, ...over,
    }))

  test('a submitted record can be sent back or rejected', () => {
    const actions = reviewer({ status: 'submitted' })
    assert.equal(actions.canRequestChanges, true)
    assert.equal(actions.canReject, true)
    assert.equal(actions.isReadOnly, false)
  })

  test('nothing can be approved in this phase', () => {
    const actions = reviewer({ status: 'submitted' })
    assert.equal(actions.canApprove, false, 'there is no approval RPC to call')
    assert.ok(APPROVE_DISABLED_REASON.length > 0, 'and the control says why it is waiting')
  })

  test('a draft belonging to somebody else offers no review action', () => {
    for (const status of ['draft', 'needs_changes', 'rejected', 'approved']) {
      const actions = reviewer({ status })
      assert.equal(actions.canRequestChanges, false, `${status} is not under review`)
      assert.equal(actions.canReject, false)
      assert.equal(actions.isReadOnly, true)
    }
  })

  test('reviewing is never the authority to submit or replace somebody’s PI', () => {
    const actions = reviewer({ status: 'submitted' })
    assert.equal(actions.canSubmit, false)
    assert.equal(actions.canChangePi, false,
      'a reviewer who can swap the workbook they are reviewing is not a reviewer')
  })

  test('an owner who is ALSO a reviewer gets their own controls, and the review ones only under review', () => {
    // A manager can raise an order and review orders. Their own draft is still
    // theirs to submit, and it is not something to review while it is a draft.
    const asDraft = describeSubmissionActions(input({ canApproveSubmission: true }))
    assert.equal(asDraft.canSubmit, true)
    assert.equal(asDraft.canReject, false)

    const submitted = describeSubmissionActions(input({ status: 'submitted', canApproveSubmission: true }))
    assert.equal(submitted.canSubmit, false, 'submitted is read-only, owner or not')
    assert.equal(submitted.canReject, true)
  })

  test('review authority alone does not open the replacement flow', () => {
    assert.equal(canReplaceSubmissionPi('draft'), true)
    assert.equal(canReplaceSubmissionPi('needs_changes'), true)
    for (const status of ['submitted', 'rejected', 'approved', 'anything_else']) {
      assert.equal(canReplaceSubmissionPi(status), false, `${status} must fail closed`)
    }
  })
})

// ── The mandatory note ────────────────────────────────────────────────────────

describe('a decision without a reason is not a decision', () => {
  test('a blank note is refused, and so is whitespace', () => {
    for (const value of ['', '   ', '\n\t ', null, undefined]) {
      const changes = validateReviewNote(value, 'needs_changes')
      const reject = validateReviewNote(value, 'reject')
      assert.equal(changes.ok, false)
      assert.equal(reject.ok, false)
    }
  })

  test('each intent says what it needs', () => {
    const changes = validateReviewNote('', 'needs_changes')
    const reject = validateReviewNote('', 'reject')
    assert.equal(changes.ok === false && changes.message, NEEDS_CHANGES_NOTE_REQUIRED)
    assert.equal(reject.ok === false && reject.message, REJECT_REASON_REQUIRED)
  })

  test('a real note is trimmed, and keeps its own line breaks', () => {
    const result = validateReviewNote('  Fabric on line 3 is wrong.\nCheck the GST too.  ', 'needs_changes')
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.note, 'Fabric on line 3 is wrong.\nCheck the GST too.')
  })
})

// ── Failures ──────────────────────────────────────────────────────────────────

describe('a failure is a sentence, never a database message', () => {
  const raw = 'ORDER_SUBMISSION_BLOCKED: 3 issue(s) must be fixed in the workbook before this can be submitted'

  test('a known marker becomes its own guidance', () => {
    const failure = describeSubmissionFailure({ message: raw }, 'submit')
    assert.equal(failure.code, 'BLOCKING_ISSUES')
    assert.ok(failure.message.includes('Change PI'))
  })

  test('the raw message is never handed back', () => {
    for (const message of [
      raw,
      'permission denied for table order_submissions',
      'duplicate key value violates unique constraint "order_submissions_pkey"',
      'null value in column "client_name" of relation "order_submissions"',
    ]) {
      const failure = describeSubmissionFailure({ message }, 'submit')
      assert.ok(!failure.message.includes(message),
        'a Postgres message carries statement text, column names and ids')
      assert.ok(!/relation|constraint|pkey|column "/i.test(failure.message))
    }
  })

  test('an unrecognised failure still says something useful, per action', () => {
    const submit = describeSubmissionFailure({ message: 'connection reset' }, 'submit')
    const back = describeSubmissionFailure({ message: 'connection reset' }, 'request_changes')
    const reject = describeSubmissionFailure({ message: 'connection reset' }, 'reject')
    assert.equal(submit.code, 'UNKNOWN')
    assert.ok(submit.message !== back.message && back.message !== reject.message,
      'each action says what could not be done')
    for (const failure of [submit, back, reject]) {
      assert.ok(!failure.message.includes('connection reset'))
    }
  })

  test('null, undefined and a bare string are all safe inputs', () => {
    for (const error of [null, undefined, '', {}, { message: null }]) {
      const failure = describeSubmissionFailure(error, 'reject')
      assert.equal(failure.code, 'UNKNOWN')
      assert.ok(failure.message.length > 0)
    }
    assert.equal(describeSubmissionFailure('ORDER_SUBMISSION_NOT_UNDER_REVIEW: …', 'reject').code,
      'NOT_UNDER_REVIEW')
  })

  test('a stale screen is told to refresh rather than blamed', () => {
    const failure = describeSubmissionFailure(
      { message: 'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted record can be rejected (this one is needs_changes)' },
      'reject',
    )
    assert.ok(/refresh/i.test(failure.message))
    assert.ok(!failure.message.includes('needs_changes'), 'and not in database words')
  })
})

// ── The status banner ─────────────────────────────────────────────────────────

describe('the contextual banner', () => {
  const banner = (over: Partial<Parameters<typeof describeSubmissionBanner>[0]> = {}) =>
    describeSubmissionBanner({
      status: 'submitted',
      submittedAt: '16 Aug 2026, 04:12 PM',
      submitterName: 'Ravi Menon',
      rejectedAt: null,
      rejectedByName: null,
      ...over,
    })

  test('a draft gets no banner', () => {
    assert.equal(banner({ status: 'draft' }), null, 'the badge already says Draft')
    assert.equal(banner({ status: 'something_new' }), null, 'and an unknown state invents nothing')
  })

  test('a submitted record names its submitter and its time', () => {
    const shown = banner()
    assert.equal(shown?.tone, 'blue')
    assert.ok(shown?.body.includes('Ravi Menon'))
    assert.ok(shown?.body.includes('16 Aug 2026, 04:12 PM'))
    assert.ok(/read|changed/i.test(shown?.body ?? ''), 'and says the record is frozen')
  })

  test('a rejection names the reviewer and when it happened', () => {
    const shown = banner({
      status: 'rejected', rejectedAt: '17 Aug 2026, 10:02 AM', rejectedByName: 'Priya Shah',
    })
    assert.equal(shown?.tone, 'red')
    assert.ok(shown?.body.includes('Priya Shah'))
    assert.ok(shown?.body.includes('17 Aug 2026, 10:02 AM'))
  })

  test('an unresolved name or time reads as a phrase, never as "null"', () => {
    const shown = banner({ submitterName: null, submittedAt: null })
    assert.ok(!/null|undefined/i.test(shown?.body ?? ''))
  })

  test('the note itself is not folded into the banner', () => {
    // It is somebody's own words, of any length, and it has its own place on
    // the overview card where it is rendered verbatim.
    const shown = banner({ status: 'needs_changes' })
    assert.ok(shown && !('note' in shown))
  })

  test('an approved record is stated and nothing more', () => {
    const shown = banner({ status: 'approved' })
    assert.equal(shown?.tone, 'green')
    assert.ok(!/approve now|approve this/i.test(shown?.body ?? ''),
      'no approval behaviour is implied by a status this phase cannot reach')
  })
})

// ── The confirmation ──────────────────────────────────────────────────────────

describe('the submit confirmation says what changes', () => {
  test('it warns that the record becomes read-only', () => {
    assert.ok(/read-only/i.test(SUBMIT_CONFIRM_NOTE))
    assert.ok(/review/i.test(SUBMIT_CONFIRM_NOTE))
  })

  test('and never promises a number or an order', () => {
    assert.ok(!/order number|numbered|confirmed order/i.test(SUBMIT_CONFIRM_NOTE))
  })
})

// ── One list, two sections ────────────────────────────────────────────────────

describe('the review queue is a section of the drafts list', () => {
  const row = (over: Partial<PersistedSubmission>): PersistedSubmission => ({
    id: over.id ?? 'x', status: 'draft', client_name: 'Client',
    created_by: OWNER, submitted_by: OWNER, submitted_at: null,
    rejected_by: null, rejected_at: null,
    creation_date: null, source_created_by: null, bill_to_name: null, ship_to_name: null,
    order_confirmation_date: null, dispatch_commitment: null, source_workbook_name: null,
    gross_product_amount: 0, discount_amount: 0, subtotal_after_discount: null,
    fabric_cost: null, fabric_cost_meaning: 'numeric', fabric_cost_text: null,
    packing_cost: null, packing_cost_meaning: 'numeric', packing_cost_text: null,
    transportation_amount: null, transportation_text: null,
    total_before_gst: null, gst_amount: null, grand_total: 1000,
    parse_warnings: [], parse_blocking_issues: [], review_note: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  })

  const entry = (over: Partial<PersistedSubmission>, name?: string) =>
    describeDraftListEntry(row(over), 1, formatInr, name)

  const entries = [
    entry({ id: 'draft-1', status: 'draft' }),
    entry({ id: 'old', status: 'submitted', submitted_at: '2026-08-10T09:00:00.000Z' }, 'Ravi Menon'),
    entry({ id: 'returned', status: 'needs_changes' }),
    entry({ id: 'new', status: 'submitted', submitted_at: '2026-08-16T09:00:00.000Z' }, 'Asha Nair'),
    entry({ id: 'unstamped', status: 'submitted', submitted_at: null }),
  ]

  test('a viewer without review authority sees the list exactly as it was', () => {
    const split = splitDraftsForReview(entries, false)
    assert.deepEqual(split.review, [])
    assert.deepEqual(split.working.map(e => e.id), entries.map(e => e.id),
      'same rows, same order — a submitted record is still the employee’s own')
  })

  test('a reviewer gets the submitted ones on top, newest submission first', () => {
    const split = splitDraftsForReview(entries, true)
    assert.deepEqual(split.review.map(e => e.id), ['new', 'old', 'unstamped'])
    assert.deepEqual(split.working.map(e => e.id), ['draft-1', 'returned'])
  })

  test('a record with no recorded submission time sorts last, never first', () => {
    const split = splitDraftsForReview(entries, true)
    assert.equal(split.review[split.review.length - 1].id, 'unstamped',
      'an unknown must not displace a known')
  })

  test('the queue order is the SUBMISSION time, not the last write', () => {
    // A returned draft is written again the moment its PI is replaced. Ordering
    // by updated_at would push a freshly corrected record above a PI that has
    // been waiting since Monday.
    const stale = entry({
      id: 'stale', status: 'submitted',
      submitted_at: '2026-08-01T09:00:00.000Z',
      updated_at: '2026-08-20T09:00:00.000Z',
    })
    const fresh = entry({
      id: 'fresh', status: 'submitted',
      submitted_at: '2026-08-19T09:00:00.000Z',
      updated_at: '2026-08-19T09:00:00.000Z',
    })
    const split = splitDraftsForReview([stale, fresh], true)
    assert.deepEqual(split.review.map(e => e.id), ['fresh', 'stale'])
  })

  test('a queue row carries the submitter and the submission time', () => {
    const [newest] = splitDraftsForReview(entries, true).review
    assert.equal(newest.submitter, 'Asha Nair')
    assert.equal(newest.submittedAt, formatSavedAt('2026-08-16T09:00:00.000Z'))
    assert.ok(newest.submittedAt.includes('2026'))
  })

  test('an unresolved submitter is a dash, never an id', () => {
    const anonymous = entry({ id: 'x', status: 'submitted', submitted_at: '2026-08-16T09:00:00.000Z' })
    assert.equal(anonymous.submitter, '—')
    assert.ok(!anonymous.submitter.includes(OWNER))
  })

  test('splitting never invents, drops or duplicates a row', () => {
    const split = splitDraftsForReview(entries, true)
    assert.equal(split.review.length + split.working.length, entries.length)
    const ids = new Set([...split.review, ...split.working].map(e => e.id))
    assert.equal(ids.size, entries.length)
  })
})

// ── The Change PI link ────────────────────────────────────────────────────────

describe('the Change PI route', () => {
  test('is built in one place, and points at the upload screen', () => {
    assert.equal(changePiHref(OWNER), `/orders/import?${CHANGE_PI_PARAM}=${OWNER}`)
    assert.ok(changePiHref(OWNER).startsWith('/orders/import?'),
      'the screen with the parser, the upload, the lease and the rollback')
  })

  test('a real id survives the round trip', () => {
    assert.equal(readChangePiTarget(OWNER), OWNER)
    assert.equal(readChangePiTarget(` ${OWNER.toUpperCase()} `), OWNER,
      'trimmed and normalised, so one record has one key')
  })

  test('anything that is not a submission id never reaches the database', () => {
    for (const value of [
      null, undefined, '', '   ', 'not-a-uuid', '../../etc/passwd',
      "1' or '1'='1", `${OWNER} or 1=1`, '11111111-1111-4111-8111',
    ]) {
      assert.equal(readChangePiTarget(value), null, `${String(value)} must be refused`)
    }
  })

  test('the id is a pointer, not a capability', () => {
    // Stated here because it is the whole security argument for putting an id in
    // a URL: the screen re-reads the record under the caller's own RLS, the
    // storage policy admits only its owner, and the server re-derives all of it
    // again. A stranger holding this link gets "not available".
    assert.equal(canReplaceSubmissionPi('submitted'), false)
    assert.equal(canReplaceSubmissionPi('rejected'), false)
  })
})

// ── The employee's reply on a resubmission ────────────────────────────────────

describe('the optional reply an employee sends with a resubmission', () => {
  test('is offered only when management has asked for changes', () => {
    assert.equal(submissionOffersReply('needs_changes'), true)
    for (const status of ['draft', 'submitted', 'rejected', 'approved', 'something_else']) {
      assert.equal(submissionOffersReply(status), false,
        `${status} has no reviewer question to answer`)
    }
  })

  test('an empty or whitespace reply is nothing at all, not an empty string', () => {
    for (const value of ['', '   ', '\n\t ', null, undefined]) {
      const result = validateResubmitReply(value)
      assert.equal(result.ok, true, 'the field is optional')
      assert.equal(result.ok && result.note, null,
        'so a field somebody tabbed through leaves no entry on the trail')
    }
  })

  test('a real reply is trimmed and kept verbatim otherwise', () => {
    const result = validateResubmitReply('  Fixed the fabric on line 3.\nGST corrected too.  ')
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.note, 'Fixed the fabric on line 3.\nGST corrected too.')
  })

  test('the cap is measured after trimming, exactly as the database measures it', () => {
    const atLimit = 'x'.repeat(RESUBMIT_NOTE_MAX_LENGTH)
    assert.equal(validateResubmitReply(atLimit).ok, true, 'the limit itself is allowed')
    assert.equal(validateResubmitReply(`   ${atLimit}   `).ok, true,
      'padding must not push a legitimate reply over the line')
    const overLimit = 'x'.repeat(RESUBMIT_NOTE_MAX_LENGTH + 1)
    const refused = validateResubmitReply(overLimit)
    assert.equal(refused.ok, false)
    assert.ok(refused.ok === false && refused.message.includes(String(RESUBMIT_NOTE_MAX_LENGTH)),
      'and the message says what the limit is')
  })

  test('the browser limit is the same number the database enforces', () => {
    // The database is the control: submit_order_submission_with_note refuses a
    // longer reply on its own. This assertion exists so the two cannot drift and
    // leave somebody typing happily into a field the server will reject.
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations',
        '20260911000000_order_submission_employee_reply.sql'), 'utf8')
    assert.ok(sql.includes(`char_length(v_note) > ${RESUBMIT_NOTE_MAX_LENGTH}`),
      'the migration must cap the reply at the same length the screen does')
  })

  test('the label and placeholder are the agreed wording', () => {
    assert.equal(RESUBMIT_NOTE_LABEL, 'Reply to management (optional)')
    assert.equal(RESUBMIT_NOTE_PLACEHOLDER,
      'Mention what you changed or answer the reviewer’s question.')
    assert.ok(RESUBMIT_NOTE_LABEL.toLowerCase().includes('optional'),
      'the label itself says the field may be left alone')
  })
})
