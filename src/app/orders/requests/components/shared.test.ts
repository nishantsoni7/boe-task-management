/**
 * Order Request shared model — the rules the list page and the dedicated
 * detail page (/orders/requests/[id]) now BOTH depend on.
 *
 * Covers what moving the detail experience onto its own route made shared:
 *   * the permission guards that decide whether an action is even offered,
 *   * the advance-received derivation, which the detail page computes from the
 *     request's own payment rows while the list computes it from a batched
 *     aggregate — the two must agree on the same request, and
 *   * the Order notification deep link, which now points at the detail route.
 *
 * Run:
 *   npx tsx --test src/app/orders/requests/components/shared.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceFromPayments,
  canEditAttachments,
  canEditRequest,
  canManagePayments,
  canPreviewAttachment,
  canRespondToClarification,
  clarificationResponseErrorMessage,
  validateClarificationResponse,
  CLARIFICATION_RESPONSE_REQUIRED,
  CLARIFICATION_STALE_MESSAGE,
  getAdvanceInfo,
  headerActionClass,
  isPermittedRequester,
  isRequestParticipant,
  previewKindOf,
  type LinkedPayment,
  type OrderRequest,
} from './shared'
import {
  buildAttachmentEditForm,
  buildRequestFormPayload,
  describeAttachmentEdits,
  editModeNotice,
  formFromRequest,
  hasAttachmentEdits,
  validateAttachmentEdits,
  validateRequestForm,
  EMPTY_ATTACHMENT_EDITS,
  REQUEST_EDIT_META,
  type AttachmentEdits,
  type StagedAttachment,
} from './RequestInlineEdit'
import {
  effectiveValueType,
  eventTitle,
  fieldLabel,
  fileNameList,
  formatRecordedValue,
  parseRecordedChanges,
  recordedChangeLines,
  titleNamesActor,
} from './RequestActivityTimeline'
import { getNotificationMeta } from '@/lib/notificationMeta'
import type { Notification } from '@/lib/types'

const ADMIN     = 'user-admin'
const REQUESTER = 'user-requester'
const ASSIGNEE  = 'user-assignee'
const OUTSIDER  = 'user-outsider'

function req(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    id: 'req-1',
    request_number: 'ORD-REQ-2026-0001',
    client_name: 'Acme Interiors',
    requested_by: REQUESTER,
    assigned_to: ASSIGNEE,
    confirm_date: null,
    due_date: null,
    total_value: 500000,
    total_product_value: 400000,
    lead_source: null,
    notes: null,
    status: 'submitted',
    created_by: REQUESTER,
    clarification_note: null,
    rejection_reason: null,
    created_at: '2026-07-01T10:00:00Z',
    converted_order_id: null,
    ...overrides,
  }
}

function pay(overrides: Partial<LinkedPayment> = {}): LinkedPayment {
  return {
    id: 'pay-1',
    request_number: 'PR-2026-0001',
    client_name: 'Acme Interiors',
    amount: 100000,
    payment_date: '2026-07-02',
    payment_mode: 'bank_transfer',
    received_in: 'company_account',
    proof_note: null,
    sales_note: null,
    status: 'approved_unlinked',
    payment_against: 'new_order',
    order_id: null,
    order_number: null,
    order_request_id: 'req-1',
    order_request_number: 'ORD-REQ-2026-0001',
    submitted_by: REQUESTER,
    created_at: '2026-07-02T10:00:00Z',
    ...overrides,
  }
}

describe('ownership rules', () => {
  test('the requester is created_by OR requested_by — never the assignee alone', () => {
    const r = req({ created_by: ADMIN, requested_by: ADMIN, assigned_to: ASSIGNEE })
    assert.equal(isPermittedRequester(r, ADMIN), true)
    assert.equal(isPermittedRequester(r, ASSIGNEE), false)
  })

  test('a participant includes the assignee, so an admin-raised request still has one', () => {
    const r = req({ created_by: ADMIN, requested_by: ADMIN, assigned_to: ASSIGNEE })
    assert.equal(isRequestParticipant(r, ASSIGNEE), true)
    assert.equal(isRequestParticipant(r, OUTSIDER), false)
  })
})

describe('canEditRequest — mirrors edit_order_request', () => {
  test('editing follows the assignment, not authorship', () => {
    const r = req({ created_by: REQUESTER, requested_by: REQUESTER, assigned_to: ASSIGNEE })
    assert.equal(canEditRequest(r, ASSIGNEE, false), true)
    // A former requester who is no longer the assignee loses the action.
    assert.equal(canEditRequest(r, REQUESTER, false), false)
    assert.equal(canEditRequest(r, ADMIN, true), true)
  })

  test('every editable status is offered, and no other', () => {
    for (const status of ['submitted', 'needs_clarification', 'rejected']) {
      assert.equal(canEditRequest(req({ status }), ADMIN, true), true, status)
    }
    assert.equal(canEditRequest(req({ status: 'converted' }), ADMIN, true), false)
  })

  test('a converted request is read-only even for an admin', () => {
    const r = req({ status: 'converted', converted_order_id: 'order-1' })
    assert.equal(canEditRequest(r, ADMIN, true), false)
    assert.equal(canEditRequest(r, ASSIGNEE, false), false)
  })
})

describe('canManagePayments — mirrors the two linkage RPCs', () => {
  test('admin, requester and assignee may all link while the request is open', () => {
    const r = req({ created_by: REQUESTER, requested_by: REQUESTER, assigned_to: ASSIGNEE })
    assert.equal(canManagePayments(r, ADMIN, true), true)
    assert.equal(canManagePayments(r, REQUESTER, false), true)
    assert.equal(canManagePayments(r, ASSIGNEE, false), true)
    assert.equal(canManagePayments(r, OUTSIDER, false), false)
  })

  test('conversion closes payment management for everyone', () => {
    const r = req({ status: 'converted', converted_order_id: 'order-1' })
    assert.equal(canManagePayments(r, ADMIN, true), false)
    assert.equal(canManagePayments(r, REQUESTER, false), false)
  })
})

describe('advance received — list aggregate and detail rows must agree', () => {
  test('a failed query is unavailable, never a confirmed zero', () => {
    assert.deepEqual(advanceFromPayments(null), { kind: 'restricted' })
    assert.deepEqual(getAdvanceInfo(req(), null), { kind: 'restricted' })
  })

  test('no parked payment reports "not linked", never ₹0', () => {
    assert.deepEqual(advanceFromPayments([]), { kind: 'not_linked' })
    assert.deepEqual(getAdvanceInfo(req(), {}), { kind: 'not_linked' })
  })

  test('only payments still parked in suspense count towards the advance', () => {
    const rows = [
      pay({ id: 'a', amount: 100000, status: 'approved_unlinked' }),
      pay({ id: 'b', amount: 50000,  status: 'approved_unlinked' }),
      // Awaiting approval — real money, but not yet received into suspense.
      pay({ id: 'c', amount: 999999, status: 'pending_approval' }),
      // Rejected outright.
      pay({ id: 'd', amount: 777777, status: 'rejected' }),
    ]
    assert.deepEqual(advanceFromPayments(rows), { kind: 'request_linked', received: 150000, count: 2 })
  })

  test('the detail derivation matches the list aggregate for the same request', () => {
    const rows = [
      pay({ id: 'a', amount: 100000 }),
      pay({ id: 'b', amount: 50000 }),
    ]
    // What the list's batched query would have produced for this request.
    const aggregate = { 'req-1': { total: 150000, count: 2 } }
    assert.deepEqual(advanceFromPayments(rows), getAdvanceInfo(req(), aggregate))
  })
})

describe('attachment preview routing', () => {
  test('the Main PI (Excel only) is previewable in the app', () => {
    assert.equal(previewKindOf('294 new Order with Replacement.xlsx'), 'sheet')
    assert.equal(previewKindOf('legacy-pi.xls'), 'sheet')
  })

  test('documents and images the browser can render safely are previewed', () => {
    assert.equal(previewKindOf('quote.pdf'),   'pdf')
    assert.equal(previewKindOf('site.JPG'),    'image')
    assert.equal(previewKindOf('plan.jpeg'),   'image')
    assert.equal(previewKindOf('render.png'),  'image')
    assert.equal(previewKindOf('sketch.webp'), 'image')
    assert.equal(previewKindOf('items.csv'),   'text')
    assert.equal(previewKindOf('notes.txt'),   'text')
  })

  test('anything outside the allow-list is download-only, never rendered', () => {
    for (const name of ['spec.docx', 'spec.doc', 'archive.zip', 'script.html', 'thing.svg', 'installer.exe', 'noextension']) {
      assert.equal(previewKindOf(name), 'none', name)
    }
  })
})

// The one preview that leaves BOE. The shared modal renders Excel through
// Microsoft's Office Online viewer, so offering it is a disclosure decision, not
// just a rendering one — hence the role in the signature.
describe('who may preview which attachment', () => {
  const EXCEL = ['294 new Order with Replacement.xlsx', 'legacy-pi.xls', 'PI.XLSX']
  const LOCAL = ['quote.pdf', 'site.JPG', 'render.png', 'sketch.webp', 'items.csv']

  test('an admin can preview a workbook', () => {
    for (const name of EXCEL) assert.equal(canPreviewAttachment(name, true), true, name)
  })

  test('a non-admin cannot — an Excel attachment is download-only for them', () => {
    for (const name of EXCEL) assert.equal(canPreviewAttachment(name, false), false, name)
  })

  test('every browser-rendered type previews for everyone, admin or not', () => {
    for (const name of LOCAL) {
      assert.equal(canPreviewAttachment(name, true),  true, name)
      assert.equal(canPreviewAttachment(name, false), true, name)
    }
  })

  test('the role never promotes a type the app cannot render at all', () => {
    for (const name of ['spec.docx', 'archive.zip', 'installer.exe', 'noextension']) {
      assert.equal(canPreviewAttachment(name, true),  false, name)
      assert.equal(canPreviewAttachment(name, false), false, name)
    }
  })

  test('.txt is still classified as previewable, though the shared modal offers download for it', () => {
    // previewKindOf keeps its allow-list; the shared component decides what it
    // can actually draw. Recorded so the divergence is deliberate, not a
    // forgotten case.
    assert.equal(previewKindOf('notes.txt'), 'text')
    assert.equal(canPreviewAttachment('notes.txt', false), true)
  })
})

// ── Responding to a clarification (20260714) ─────────────────────────────────
// The defect this covers: an admin raising a request on a salesperson's behalf
// left created_by AND requested_by pointing at the admin, so the old
// isPermittedRequester rule locked the assignee — the only person who could
// answer — out of the resubmission entirely, at BOTH the button and the RPC.
describe('who may respond to a clarification', () => {
  const needsClarification = (o: Partial<OrderRequest> = {}) =>
    req({ status: 'needs_clarification', clarification_note: 'Confirm the revised product value.', ...o })

  // THE REGRESSION TEST. created_by and requested_by are the admin; the
  // salesperson is only the assignee.
  test('the current assignee of an admin-raised request can respond', () => {
    const r = needsClarification({ created_by: ADMIN, requested_by: ADMIN, assigned_to: ASSIGNEE })
    assert.equal(canRespondToClarification(r, ASSIGNEE, false), true)
  })

  test('the requester can respond, by either sense of the word', () => {
    assert.equal(canRespondToClarification(needsClarification({ requested_by: REQUESTER }), REQUESTER, false), true)
    assert.equal(canRespondToClarification(
      needsClarification({ created_by: REQUESTER, requested_by: ADMIN }), REQUESTER, false), true)
  })

  test('an admin retains the right', () => {
    const r = needsClarification({ created_by: OUTSIDER, requested_by: OUTSIDER, assigned_to: OUTSIDER })
    assert.equal(canRespondToClarification(r, ADMIN, true), true)
  })

  test('an unrelated user cannot — the widening stops at the assignee', () => {
    assert.equal(canRespondToClarification(needsClarification(), OUTSIDER, false), false)
  })

  test('a FORMER assignee loses the right the moment the request is reassigned', () => {
    const r = needsClarification({ created_by: ADMIN, requested_by: ADMIN, assigned_to: OUTSIDER })
    assert.equal(canRespondToClarification(r, ASSIGNEE, false), false)
  })

  test('only a request actually awaiting clarification offers it', () => {
    for (const status of ['submitted', 'rejected', 'converted']) {
      assert.equal(canRespondToClarification(req({ status }), ASSIGNEE, false), false, status)
      assert.equal(canRespondToClarification(req({ status }), ADMIN,    true),  false, status)
    }
  })

  test('a converted request never offers it, whatever its status column says', () => {
    const r = needsClarification({ converted_order_id: 'order-1' })
    assert.equal(canRespondToClarification(r, ASSIGNEE, false), false)
    assert.equal(canRespondToClarification(r, ADMIN,    true),  false)
  })
})

describe('the response is mandatory', () => {
  test('empty is rejected with the exact message', () => {
    assert.equal(validateClarificationResponse(''), CLARIFICATION_RESPONSE_REQUIRED)
    assert.equal(CLARIFICATION_RESPONSE_REQUIRED, 'Enter a response to the clarification before resubmitting.')
  })

  test('whitespace-only is rejected — trimming must not turn blank into valid', () => {
    for (const blank of ['   ', '\t', '\n', ' \n\t ', ' '.trim()]) {
      assert.equal(validateClarificationResponse(blank), CLARIFICATION_RESPONSE_REQUIRED, JSON.stringify(blank))
    }
  })

  test('real text passes, including text that merely starts with whitespace', () => {
    assert.equal(validateClarificationResponse('Updated the product value.'), null)
    assert.equal(validateClarificationResponse('  Attached the revised PI.  '), null)
  })
})

describe('clarification response failures name the rule that refused', () => {
  test('a stale request is told to refresh, not to retry', () => {
    const msg = clarificationResponseErrorMessage({
      code: 'P0001',
      message: 'Order request ORD-REQ-2026-0001 is no longer awaiting clarification (it is submitted)',
    })
    assert.equal(msg, CLARIFICATION_STALE_MESSAGE)
    assert.match(msg, /Refresh the page/)
  })

  test('a non-admin assignee change is refused in its own words', () => {
    assert.equal(
      clarificationResponseErrorMessage({ code: '42501', message: 'Only an admin may change the assignee of an order request' }),
      'Only an admin can change the assignee of an order request.',
    )
  })

  test('a permission refusal never reads as a stale request', () => {
    const msg = clarificationResponseErrorMessage({
      code: '42501', message: 'You do not have permission to respond to this clarification',
    })
    assert.equal(msg, 'You do not have permission to respond to this clarification.')
    assert.doesNotMatch(msg, /Refresh/)
  })

  test('a missing RPC says the server is behind, not that the file was wrong', () => {
    assert.match(
      clarificationResponseErrorMessage({ code: 'PGRST202', message: 'Could not find the function' }),
      /not available on this server yet/,
    )
    assert.match(
      clarificationResponseErrorMessage({ code: '', message: 'schema cache' }),
      /not available on this server yet/,
    )
  })

  test('only true conflict codes claim someone else is editing', () => {
    for (const code of ['40001', '55P03']) {
      assert.match(clarificationResponseErrorMessage({ code, message: '' }), /Someone else is changing/, code)
    }
    // A generic failure must NOT invent a phantom concurrent edit.
    assert.doesNotMatch(clarificationResponseErrorMessage({ code: 'XX000', message: 'boom' }), /Someone else/)
  })

  test('the server-side "response required" refusal maps back to the client sentence', () => {
    assert.equal(
      clarificationResponseErrorMessage({ code: 'P0001', message: 'A response to the clarification is required' }),
      CLARIFICATION_RESPONSE_REQUIRED,
    )
  })
})

describe('clarification activity reads as an exchange', () => {
  test('the response event names its author', () => {
    assert.equal(eventTitle('clarification_responded', 'Priya'), 'Priya responded to clarification')
    assert.equal(titleNamesActor('clarification_responded'), true)
  })

  test('the admin request keeps its own neutral title — the two are separate events', () => {
    assert.equal(eventTitle('clarification_requested', 'Nishant'), 'Clarification requested')
    assert.equal(titleNamesActor('clarification_requested'), false)
  })

  test('field changes made in the same submission carry before AND after values', () => {
    const lines = recordedChangeLines(
      {
        clarification_response: 'Updated the product value and attached the revised PI.',
        changed_fields: ['total_product_value'],
        changes: [{
          field: 'total_product_value', label: 'Total Product Value',
          value_type: 'currency', old_value: 240000, new_value: 225000,
        }],
      },
      {},
      fieldLabel,
    )
    assert.equal(lines.length, 1)
    // Rendered in the same Indian-numbering currency format as every other
    // amount in the product — the audit rail must not be the one place that
    // prints a raw number.
    assert.equal(lines[0], 'Total Product Value changed from ₹2,40,000 to ₹2,25,000')
  })

  test('a response with no field edits produces NO field-change lines', () => {
    // The RPC records changed_fields: [] and changes: [] when only the answer was
    // given. Nothing must invent an edit that did not happen.
    assert.deepEqual(
      recordedChangeLines({ clarification_response: 'Confirmed, no change needed.', changed_fields: [], changes: [] }, {}, fieldLabel),
      [],
    )
  })
})

describe('respond-and-resubmit copy', () => {
  test('the primary action names the response, not the update', () => {
    assert.equal(REQUEST_EDIT_META.resubmit.submit, 'Respond and Resubmit')
  })

  test('the edit-mode notice points at the new label, never the old one', () => {
    const notice = editModeNotice('edit', 'needs_clarification')
    assert.match(notice, /Respond and Resubmit/)
    assert.doesNotMatch(notice, /Update and Resubmit/)
  })

  test('resubmit mode states that the response is recorded too', () => {
    assert.match(editModeNotice('resubmit', 'needs_clarification'), /records your response/)
  })
})

describe('inline edit form', () => {
  test('the form is seeded from the record, with nulls as empty strings', () => {
    const form = formFromRequest(req({
      confirm_date: '2026-07-15',
      due_date: null,
      lead_source: null,
      notes: null,
      total_value: 240000,
      total_product_value: null,
    }))
    assert.equal(form.client_name,         'Acme Interiors')
    assert.equal(form.assigned_to,         ASSIGNEE)
    assert.equal(form.confirm_date,        '2026-07-15')
    assert.equal(form.due_date,            '')
    assert.equal(form.lead_source,         '')
    assert.equal(form.notes,               '')
    assert.equal(form.total_value,         '240000')
    assert.equal(form.total_product_value, '')
  })

  test('client name is required; blank amounts are allowed', () => {
    const base = formFromRequest(req())
    assert.equal(validateRequestForm({ ...base, total_value: '', total_product_value: '' }), null)
    assert.match(validateRequestForm({ ...base, client_name: '   ' }) ?? '', /Client name is required/)
  })

  test('a negative or unparseable amount is refused before the round trip', () => {
    const base = formFromRequest(req())
    assert.match(validateRequestForm({ ...base, total_value: '-1' }) ?? '', /Total Order Value/)
    assert.match(validateRequestForm({ ...base, total_product_value: 'abc' }) ?? '', /Total Product Value/)
  })

  test('the save notice never claims a status move that the mode does not make', () => {
    // An edit leaves status alone, so it must say what the request STILL is.
    assert.match(editModeNotice('edit', 'needs_clarification'), /still needs clarification/)
    assert.match(editModeNotice('edit', 'rejected'),            /stays rejected/)
    assert.match(editModeNotice('edit', 'submitted'),           /stays under review/)
    // These two do hand the request back, and say so.
    assert.match(editModeNotice('resubmit', 'needs_clarification'), /back for review/)
    assert.match(editModeNotice('reapply',  'rejected'),            /for review again/)
  })
})

describe('header action styling', () => {
  test('every variant carries the shared base class, so contrast is defined once', () => {
    for (const v of ['secondary', 'danger', 'primary', 'icon'] as const) {
      assert.match(headerActionClass(v), /(^|\s)boe-record-action(\s|$)/, v)
    }
    assert.match(headerActionClass(), /(^|\s)boe-record-action(\s|$)/)
  })

  test('secondary is the plain base; the others add exactly one modifier', () => {
    assert.equal(headerActionClass('secondary'), 'boe-record-action')
    assert.equal(headerActionClass('danger'),    'boe-record-action boe-record-action--danger')
    assert.equal(headerActionClass('primary'),   'boe-record-action boe-record-action--primary')
    assert.equal(headerActionClass('icon'),      'boe-record-action boe-record-action--icon')
  })
})

describe('attachment editing permissions', () => {
  test('attachment editing follows exactly the same rule as editing the request', () => {
    for (const status of ['submitted', 'needs_clarification', 'rejected', 'converted']) {
      for (const [uid, admin] of [[ADMIN, true], [ASSIGNEE, false], [REQUESTER, false], [OUTSIDER, false]] as const) {
        const r = req({ status, converted_order_id: status === 'converted' ? 'order-1' : null })
        assert.equal(
          canEditAttachments(r, uid, admin),
          canEditRequest(r, uid, admin),
          `${status}/${uid}`,
        )
      }
    }
  })

  test('a converted request can never have its attachments edited', () => {
    const r = req({ status: 'converted', converted_order_id: 'order-1' })
    assert.equal(canEditAttachments(r, ADMIN, true), false)
    assert.equal(canEditAttachments(r, ASSIGNEE, false), false)
  })

  test('the creator alone gains nothing — attachment editing follows the assignment', () => {
    const r = req({ created_by: REQUESTER, requested_by: REQUESTER, assigned_to: ASSIGNEE })
    assert.equal(canEditAttachments(r, REQUESTER, false), false)
    assert.equal(canEditAttachments(r, ASSIGNEE, false), true)
  })
})

describe('staged attachment changes', () => {
  const ready = (over: Partial<StagedAttachment> = {}): StagedAttachment => ({
    localId: 'staged-1', displayName: 'pi.xlsx',
    file: { name: 'pi.xlsx' } as unknown as File,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    originalSize: 1000, finalSize: 1000, compressed: false,
    status: 'ready', error: null, ...over,
  })

  test('an untouched editor has nothing to apply', () => {
    assert.equal(hasAttachmentEdits(EMPTY_ATTACHMENT_EDITS), false)
    assert.equal(validateAttachmentEdits(EMPTY_ATTACHMENT_EDITS), null)
    assert.equal(describeAttachmentEdits(EMPTY_ATTACHMENT_EDITS), null)
  })

  test('there is no shape that removes the Main PI — it can only be replaced', () => {
    // The staged type has a `mainPi` REPLACEMENT slot and no removal flag, so a
    // save can never ask for a request with no Main PI. This pins that shape.
    const keys = Object.keys(EMPTY_ATTACHMENT_EDITS)
    assert.deepEqual(keys.sort(), ['addRefs', 'mainPi', 'removeRefIds'])
  })

  test('a Main PI replacement that is not ready blocks the save', () => {
    const preparing: AttachmentEdits = { ...EMPTY_ATTACHMENT_EDITS, mainPi: ready({ status: 'preparing', file: null }) }
    assert.match(validateAttachmentEdits(preparing) ?? '', /still being prepared/)

    const failed: AttachmentEdits = {
      ...EMPTY_ATTACHMENT_EDITS,
      mainPi: ready({ status: 'error', file: null, error: 'The Main PI must be an Excel file.' }),
    }
    assert.match(validateAttachmentEdits(failed) ?? '', /must be an Excel file/)
  })

  test('a rejected reference blocks the save and names itself', () => {
    const edits: AttachmentEdits = {
      ...EMPTY_ATTACHMENT_EDITS,
      addRefs: [ready({ localId: 'a', displayName: 'huge.pdf', status: 'error', file: null, error: '“huge.pdf” is too large.' })],
    }
    assert.match(validateAttachmentEdits(edits) ?? '', /huge\.pdf/)
  })

  test('a fully prepared set passes and is summarised for the user', () => {
    const edits: AttachmentEdits = {
      mainPi: ready(),
      addRefs: [ready({ localId: 'a', displayName: 'drawing.pdf' })],
      removeRefIds: ['ref-1'],
    }
    assert.equal(validateAttachmentEdits(edits), null)
    assert.equal(hasAttachmentEdits(edits), true)
    assert.equal(describeAttachmentEdits(edits), 'Main PI replaced · 1 reference file added · 1 removed')
  })

  test('a Replace counts once, not as a separate add and remove', () => {
    // A staged addition that supersedes ref-1 also stages ref-1 for removal.
    // The summary must not report that as an extra standalone removal.
    const edits: AttachmentEdits = {
      mainPi: null,
      addRefs: [ready({ localId: 'a', displayName: 'v2.pdf', replacesId: 'ref-1', replacesName: 'v1.pdf' })],
      removeRefIds: ['ref-1'],
    }
    assert.equal(describeAttachmentEdits(edits), '1 reference file added')
  })
})

describe('attachment activity details', () => {
  test('recorded file-name lists are narrowed defensively', () => {
    assert.deepEqual(fileNameList(['a.pdf', 'b.png']), ['a.pdf', 'b.png'])
    assert.deepEqual(fileNameList(['a.pdf', '', null, 7, 'c.txt']), ['a.pdf', 'c.txt'])
    assert.deepEqual(fileNameList(undefined), [])
    assert.deepEqual(fileNameList('a.pdf'), [])
  })
})

// ── The request the attachment-edit save actually sends ───────────────────────
// SCOPE, STATED HONESTLY: there is no component-test harness in this repo, so
// saveEdit's orchestration (attachments → fields, and the abort that leaves the
// staging intact) cannot be executed here. What IS asserted is the exact payload
// the route receives, which is where the add-a-reference save was failing, plus
// the guard that decides whether the route is called at all.
describe('attachment-edit request payload', () => {
  const file = (name: string, body = 'x') => new File([body], name, { type: 'application/pdf' })

  function staged(name: string, over: Partial<StagedAttachment> = {}): StagedAttachment {
    return {
      localId: name, displayName: name, file: file(name),
      contentType: 'application/pdf', originalSize: 10, finalSize: 10,
      compressed: false, status: 'ready', error: null, ...over,
    }
  }

  test('one added reference travels as a single references entry', () => {
    const fd = buildAttachmentEditForm('req-1', {
      mainPi: null, addRefs: [staged('drawing.pdf')], removeRefIds: [],
    })
    assert.equal(fd.get('requestId'), 'req-1')
    assert.equal(fd.get('mainPi'), null)
    const refs = fd.getAll('references') as File[]
    assert.equal(refs.length, 1)
    assert.equal(refs[0].name, 'drawing.pdf')
    // An empty removal list is still sent, so the route parses [] rather than
    // treating a missing field as malformed.
    assert.equal(fd.get('removeIds'), '[]')
  })

  test('several added references each travel as their own entry', () => {
    const fd = buildAttachmentEditForm('req-1', {
      mainPi: null,
      addRefs: [staged('a.pdf'), staged('b.pdf'), staged('c.pdf')],
      removeRefIds: [],
    })
    assert.deepEqual((fd.getAll('references') as File[]).map(f => f.name), ['a.pdf', 'b.pdf', 'c.pdf'])
  })

  test('a Main PI replacement and reference changes travel in ONE request', () => {
    const fd = buildAttachmentEditForm('req-1', {
      mainPi: staged('pi-v2.xlsx'),
      addRefs: [staged('extra.pdf')],
      removeRefIds: ['ref-1', 'ref-2'],
    })
    assert.equal((fd.get('mainPi') as File).name, 'pi-v2.xlsx')
    assert.equal((fd.getAll('references') as File[]).length, 1)
    assert.equal(fd.get('removeIds'), JSON.stringify(['ref-1', 'ref-2']))
  })

  test('a removal-only change sends no files', () => {
    const fd = buildAttachmentEditForm('req-1', {
      mainPi: null, addRefs: [], removeRefIds: ['ref-1'],
    })
    assert.equal(fd.get('mainPi'), null)
    assert.equal(fd.getAll('references').length, 0)
    assert.equal(fd.get('removeIds'), '["ref-1"]')
  })

  test('nothing staged means the attachment route is never called', () => {
    // saveEdit calls applyAttachmentEdits only when this is true, so a
    // field-only edit cannot produce an attachment request — or an attachment
    // event on a request whose files did not change.
    assert.equal(hasAttachmentEdits(EMPTY_ATTACHMENT_EDITS), false)
    assert.equal(hasAttachmentEdits({ mainPi: null, addRefs: [staged('a.pdf')], removeRefIds: [] }), true)
  })

  test('a half-prepared file is refused BEFORE any request is built', () => {
    // The bytes are missing, so buildAttachmentEditForm would silently omit the
    // file while its staged removal still travelled — a Replace turning into a
    // deletion. validateAttachmentEdits is what stops the save first.
    const edits: AttachmentEdits = {
      mainPi: null,
      addRefs: [staged('slow.pdf', { file: null, status: 'preparing' })],
      removeRefIds: ['ref-1'],
    }
    assert.match(validateAttachmentEdits(edits) ?? '', /slow\.pdf/)
  })
})

// ── Request-edit audit history ────────────────────────────────────────────────
// The rail renders what the database RECORDED. These cover both generations of
// request_edited payload, because historical rows are never rewritten.
describe('request-edit audit rendering', () => {
  const NAMES = { 'user-1': 'Priya Sharma', 'user-2': 'Rahul Verma' }

  function change(over: Record<string, unknown> = {}) {
    return {
      field: 'total_product_value', label: 'Total Product Value',
      value_type: 'currency', old_value: 240000, new_value: 225000, ...over,
    }
  }

  test('one changed currency field renders its recorded before and after', () => {
    const lines = recordedChangeLines({ changes: [change()] }, NAMES, fieldLabel)
    assert.deepEqual(lines, ['Total Product Value changed from ₹2,40,000 to ₹2,25,000'])
  })

  test('several changed fields render one line each, in recorded order', () => {
    const lines = recordedChangeLines({
      changes: [
        change(),
        change({ field: 'lead_source', label: 'Lead Source', value_type: 'lead_source',
                 old_value: 'website', new_value: 'repeat_customer' }),
        change({ field: 'due_date', label: 'Due Date', value_type: 'date',
                 old_value: '2026-07-31', new_value: '2026-08-05' }),
      ],
    }, NAMES, fieldLabel)
    assert.deepEqual(lines, [
      'Total Product Value changed from ₹2,40,000 to ₹2,25,000',
      'Lead Source changed from Website to Repeat Customer',
      'Due Date changed from 31 Jul 2026 to 5 Aug 2026',
    ])
  })

  test('a lead source reads as its label, never as the stored machine value', () => {
    // The column stores 'repeat_customer'; the record field and the edit
    // dropdown both show "Repeat Customer". The audit rail must agree with them
    // — it is the one surface that would otherwise print the raw enum.
    const lines = recordedChangeLines({
      changes: [change({ field: 'lead_source', label: 'Lead Source',
                         value_type: 'lead_source',
                         old_value: 'reference', new_value: 'repeat_customer' })],
    }, NAMES, fieldLabel)
    assert.deepEqual(lines, ['Lead Source changed from Reference to Repeat Customer'])
    // Every value the dropdown can produce resolves; none renders with an
    // underscore.
    for (const stored of ['reference', 'repeat_customer', 'whatsapp', 'instagram', 'website']) {
      assert.doesNotMatch(formatRecordedValue(stored, 'lead_source', {}), /_/)
    }
  })

  test('an empty or retired lead source still renders honestly', () => {
    assert.equal(formatRecordedValue(null, 'lead_source', {}), 'Not set')
    assert.equal(formatRecordedValue('', 'lead_source', {}), 'Not set')
    // A value no longer on the list is shown as recorded rather than dropped —
    // history still has to render.
    assert.equal(formatRecordedValue('cold_call', 'lead_source', {}), 'cold_call')
  })

  test('a lead source recorded as plain text is still resolved by field name', () => {
    // Back-compat: a row written by any producer that typed lead_source as
    // 'text' must not become the one entry that prints the raw enum.
    assert.equal(effectiveValueType('lead_source', 'text'), 'lead_source')
    assert.equal(effectiveValueType('lead_source', undefined), 'lead_source')
    // Every other field keeps exactly the type the database recorded.
    assert.equal(effectiveValueType('notes', 'notes'), 'notes')
    assert.equal(effectiveValueType('assigned_to', 'user'), 'user')
    assert.equal(effectiveValueType('future_column', 'colour'), 'colour')

    const lines = recordedChangeLines({
      changes: [{ field: 'lead_source', label: 'Lead Source', value_type: 'text',
                  old_value: 'website', new_value: 'instagram' }],
    }, NAMES, fieldLabel)
    assert.deepEqual(lines, ['Lead Source changed from Website to Instagram'])
  })

  test('an unchanged field is absent from the record, so it cannot render', () => {
    // The RPC only appends a `changes` entry for a field that genuinely moved.
    assert.deepEqual(recordedChangeLines({ changes: [] }, NAMES, fieldLabel), [])
    assert.deepEqual(parseRecordedChanges({ changed_fields: ['notes'] }), [])
  })

  test('a date is shown readably, never as a raw ISO string', () => {
    assert.equal(formatRecordedValue('2026-07-31', 'date', {}), '31 Jul 2026')
    // A value that is not an ISO date is shown as recorded rather than becoming
    // "Invalid Date".
    assert.equal(formatRecordedValue('sometime', 'date', {}), 'sometime')
  })

  test('null to value, and value to null, read as "Not set"', () => {
    const toValue = recordedChangeLines({
      changes: [change({ field: 'due_date', label: 'Due Date', value_type: 'date',
                         old_value: null, new_value: '2026-07-31' })],
    }, NAMES, fieldLabel)
    assert.deepEqual(toValue, ['Due Date changed from Not set to 31 Jul 2026'])

    const toNull = recordedChangeLines({
      changes: [change({ old_value: 240000, new_value: null })],
    }, NAMES, fieldLabel)
    assert.deepEqual(toNull, ['Total Product Value changed from ₹2,40,000 to Not set'])
  })

  test('an assignee change shows display names, never user ids', () => {
    const lines = recordedChangeLines({
      changes: [change({ field: 'assigned_to', label: 'Assignee', value_type: 'user',
                         old_value: 'user-1', new_value: 'user-2' })],
    }, NAMES, fieldLabel)
    assert.deepEqual(lines, ['Assignee changed from Priya Sharma to Rahul Verma'])
    // An absent user is "Unassigned" — the domain meaning — not "Not set".
    assert.equal(formatRecordedValue(null, 'user', NAMES), 'Unassigned')
    // An id that could not be resolved is never printed raw.
    assert.equal(formatRecordedValue('user-9', 'user', NAMES), 'Unknown user')
  })

  test('notes are quoted, and long notes are clipped for the narrow rail', () => {
    const long = 'A'.repeat(90)
    const lines = recordedChangeLines({
      changes: [change({ field: 'notes', label: 'Notes', value_type: 'notes',
                         old_value: 'Old note', new_value: long })],
    }, NAMES, fieldLabel)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^Notes changed from “Old note” to “A+…”$/)
    assert.ok(lines[0].length < long.length + 40)
  })

  test('two values that RENDER alike are not reported as "from X to X"', () => {
    // Long notes clipped to the same prefix genuinely differ in the record; the
    // line states the change without asserting a false before/after pair.
    const lines = recordedChangeLines({
      changes: [change({ field: 'notes', label: 'Notes', value_type: 'notes',
                         old_value: `${'B'.repeat(70)}one`, new_value: `${'B'.repeat(70)}two` })],
    }, NAMES, fieldLabel)
    assert.deepEqual(lines, ['Notes updated'])
  })

  test('a legacy request_edited row still renders from field names alone', () => {
    // 20260708/20260709 recorded no values. parseRecordedChanges finds nothing,
    // which is the signal for the caller's legacy path — the old values are NOT
    // reconstructed from the current row.
    assert.deepEqual(parseRecordedChanges({ changed_fields: ['total_product_value'] }), [])
    assert.equal(fieldLabel('total_product_value'), 'Total Product Value')
  })

  test('malformed change entries are dropped, not rendered as blanks', () => {
    const parsed = parseRecordedChanges({
      changes: [change(), { label: 'No field' }, null, 'nonsense', { field: '   ' }],
    })
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].field, 'total_product_value')
  })

  test('an unknown field keeps the label the database recorded', () => {
    assert.equal(fieldLabel('future_column', 'Future Column'), 'Future Column')
    assert.equal(fieldLabel('future_column'), 'future_column')
  })

  test('an attachment-only save cannot file a false field edit', () => {
    // saveEdit always calls the field RPC, even when only files changed. What
    // stops a bogus "edited the request" entry is that the RPC returns early —
    // writing no row and no activity — when nothing differs. That early return
    // compares the SUBMITTED form against the stored row, so the property it
    // depends on is asserted here: the form derived from a request carries the
    // same values back, field for field. The early return itself is server-side
    // and is covered by the RPC (20260713 step 8) rather than by this test.
    const r = req({
      client_name: 'Acme Interiors', assigned_to: ASSIGNEE,
      confirm_date: '2026-07-10', due_date: '2026-07-31',
      total_value: 500000, total_product_value: 400000,
      lead_source: 'Website', notes: 'Deliver in two lots',
    })
    const f = formFromRequest(r)
    assert.equal(f.client_name, r.client_name)
    assert.equal(f.assigned_to, r.assigned_to)
    assert.equal(f.confirm_date, r.confirm_date)
    assert.equal(f.due_date, r.due_date)
    assert.equal(f.lead_source, r.lead_source)
    assert.equal(f.notes, r.notes)
    assert.equal(parseFloat(f.total_value), r.total_value)
    assert.equal(parseFloat(f.total_product_value), r.total_product_value)
    // An unset field round-trips as '' and is sent as NULL, so it is equally
    // unchanged — it must not register as a "Not set → Not set" edit.
    const empty = formFromRequest(req({ due_date: null, notes: null, lead_source: null }))
    assert.equal(empty.due_date, '')
    assert.equal(empty.notes, '')
    assert.equal(empty.lead_source, '')
  })

  test('the edit entry names the actor once, in its title', () => {
    assert.equal(eventTitle('request_edited', 'Nishant'), 'Nishant edited the request')
    // Other events keep the neutral title; their actor stays in the meta line.
    assert.equal(eventTitle('request_converted', 'Nishant'), 'Converted to Confirmed Order')
    assert.equal(eventTitle('main_pi_replaced', 'Nishant'), 'Main PI replaced')
  })
})

describe('edit RPC arguments — what decides a field "changed"', () => {
  // edit_order_request compares these arguments against the stored row with
  // `is distinct from`. A normalisation mismatch here does not just look wrong:
  // it writes an audit entry for a change nobody made.

  test('an untouched form sends every value back exactly as it is stored', () => {
    const r = req({
      client_name: 'Acme Interiors', assigned_to: ASSIGNEE,
      confirm_date: '2026-07-10', due_date: '2026-07-31',
      total_value: 500000, total_product_value: 400000,
      lead_source: 'repeat_customer', notes: 'Deliver in two lots',
    })
    const p = buildRequestFormPayload(r.id, formFromRequest(r))
    assert.deepEqual(p, {
      p_order_request_id:    r.id,
      p_client_name:         r.client_name,
      p_assigned_to:         r.assigned_to,
      p_confirm_date:        r.confirm_date,
      p_due_date:            r.due_date,
      p_total_value:         r.total_value,
      p_total_product_value: r.total_product_value,
      p_lead_source:         r.lead_source,
      p_notes:               r.notes,
    })
  })

  test('an unset field travels as NULL, never as an empty string', () => {
    // '' would be DISTINCT FROM a stored NULL, so every empty control on an
    // otherwise untouched form would be logged as an edit.
    const r = req({
      confirm_date: null, due_date: null, lead_source: null,
      assigned_to: null, total_value: null, total_product_value: null,
    })
    const p = buildRequestFormPayload(r.id, formFromRequest(r))
    assert.equal(p.p_confirm_date, null)
    assert.equal(p.p_due_date, null)
    assert.equal(p.p_lead_source, null)
    assert.equal(p.p_assigned_to, null)
    assert.equal(p.p_total_value, null)
    assert.equal(p.p_total_product_value, null)

    // notes is the ONE deliberate exception: it travels raw, as '', because the
    // RPC applies `nullif(btrim(...), '')` itself and compares its own
    // normalised result against the stored value. Empty notes therefore still
    // arrive at the comparison as NULL and register no change — normalising
    // here as well would be the same rule written twice, free to drift.
    assert.equal(p.p_notes, '')
    for (const [k, v] of Object.entries(p)) {
      if (k === 'p_notes') continue
      assert.notEqual(v, '', `${k} must send NULL rather than an empty string`)
    }
  })

  test('amounts travel as numbers, so a re-typed value is not a text change', () => {
    const p = buildRequestFormPayload('req-1', {
      ...formFromRequest(req()), total_value: '500000', total_product_value: '400000.50',
    })
    assert.equal(typeof p.p_total_value, 'number')
    assert.equal(p.p_total_value, 500000)
    assert.equal(p.p_total_product_value, 400000.5)
    // A genuine zero is a value, not an absence.
    assert.equal(buildRequestFormPayload('req-1', { ...formFromRequest(req()), total_value: '0' }).p_total_value, 0)
  })

  test('a date keeps the stored ISO form, so serialisation cannot fake a change', () => {
    const r = req({ due_date: '2026-07-31', confirm_date: '2026-07-10' })
    const p = buildRequestFormPayload(r.id, formFromRequest(r))
    assert.equal(p.p_due_date, '2026-07-31')
    assert.equal(p.p_confirm_date, '2026-07-10')
  })

  test('no browser File is ever serialised into the field payload', () => {
    // Attachments travel as multipart form data to their own route. The field
    // RPC arguments are the eight editable columns and the request id — nothing
    // else — so a selected file can never reach a database update payload.
    const p = buildRequestFormPayload('req-1', formFromRequest(req()))
    assert.deepEqual(Object.keys(p).sort(), [
      'p_assigned_to', 'p_client_name', 'p_confirm_date', 'p_due_date',
      'p_lead_source', 'p_notes', 'p_order_request_id', 'p_total_product_value',
      'p_total_value',
    ])
    for (const v of Object.values(p)) {
      assert.ok(v === null || typeof v === 'string' || typeof v === 'number',
        'every argument is a plain JSON scalar')
    }
    assert.ok(JSON.stringify(p).length > 0, 'the payload is JSON-serialisable')
  })

  test('a non-admin sends the assignee back unchanged, so it is never a change', () => {
    // The RPC REJECTS a differing p_assigned_to from a non-admin rather than
    // ignoring it, so an assignee saving any other field depends on this.
    const r = req({ assigned_to: ASSIGNEE })
    assert.equal(buildRequestFormPayload(r.id, formFromRequest(r)).p_assigned_to, ASSIGNEE)
  })
})

describe('Order notification deep links', () => {
  function notif(type: string, entityId: string | null): Notification {
    return {
      id: 'n-1', user_id: 'u-1', task_id: null, entity_id: entityId,
      type, title: 'Order request submitted', body: null,
      is_read: false, is_push_sent: false, is_digest: false,
      created_at: '2026-07-25T10:00:00Z', read_at: null,
    }
  }

  test('an order-request notification opens the dedicated detail page', () => {
    const meta = getNotificationMeta(notif('order_submitted', 'req-1'))
    assert.equal(meta.href, '/orders/requests/req-1?from=all')
  })

  test('order_converted still points at the Confirmed Order, not the request', () => {
    const meta = getNotificationMeta(notif('order_converted', 'order-1'))
    assert.equal(meta.href, '/orders/order-1')
  })

  test('a notification with no entity falls back to the list', () => {
    const meta = getNotificationMeta(notif('order_rejected', null))
    assert.equal(meta.href, '/orders/requests')
  })
})
