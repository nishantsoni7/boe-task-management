/**
 * The Save Draft flow's rules, tested away from the screen.
 *
 * WHAT THESE DEFEND. The button decides when an employee may commit a document
 * to the database, and the messages decide what they believe happened. The
 * failures that matter are all quiet ones:
 *
 *   * a save allowed while the browser already knows the PI is broken;
 *   * a second save started by a second click;
 *   * a success message that reads as though an order exists;
 *   * the browser's counts shown after the server saved different ones;
 *   * a server rejection of the DOCUMENT presented as a retryable glitch.
 *
 * Offline and pure. No network, no database, no browser.
 *
 * Run:
 *   npx tsx --test src/lib/orders/saveDraftFlow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SAVE_STAGES,
  SAVE_BUTTON_LABEL,
  SAVE_SUCCESS_NO_NUMBER_NOTE,
  canSaveDraft,
  describeSaveFailure,
  summariseSaveResult,
  saveStageLabel,
  saveStageIndex,
  workbookObjectPath,
  WORKBOOK_UPLOAD_MIME,
} from './saveDraftFlow'
import { isWorkbookPathFor } from './submissionPayload'

const SUBMISSION = '11111111-2222-4333-8444-555555555555'
const OBJECT = '66666666-7777-4888-8999-aaaaaaaaaaaa'

const gate = (over: Partial<Parameters<typeof canSaveDraft>[0]> = {}) => ({
  hasPreview: true,
  blockingCount: 0,
  saving: false,
  saved: false,
  ...over,
})

// ── The gate ──────────────────────────────────────────────────────────────────

describe('canSaveDraft', () => {
  test('allows a save when a clean PI is on screen', () => {
    assert.equal(canSaveDraft(gate()), true)
  })

  test('refuses while the browser knows there are blocking issues', () => {
    assert.equal(canSaveDraft(gate({ blockingCount: 1 })), false)
    assert.equal(canSaveDraft(gate({ blockingCount: 7 })), false)
  })

  test('refuses with no preview at all', () => {
    assert.equal(canSaveDraft(gate({ hasPreview: false })), false)
  })

  test('refuses while a save is already running — the double-click case', () => {
    assert.equal(canSaveDraft(gate({ saving: true })), false)
  })

  test('refuses once the draft has been saved', () => {
    assert.equal(canSaveDraft(gate({ saved: true })), false)
  })

  test('every reason refuses independently', () => {
    assert.equal(canSaveDraft(gate({ blockingCount: 1, saving: true })), false)
    assert.equal(canSaveDraft(gate({ hasPreview: false, blockingCount: 0 })), false)
  })

  test('the label never says "submit"', () => {
    assert.equal(SAVE_BUTTON_LABEL, 'Save Draft')
    assert.ok(!/submit/i.test(SAVE_BUTTON_LABEL), 'approval is a later phase')
    assert.ok(!/approv/i.test(SAVE_BUTTON_LABEL))
  })
})

// ── Progress ──────────────────────────────────────────────────────────────────

describe('progress stages', () => {
  test('there are four, in the order they happen', () => {
    assert.deepEqual(SAVE_STAGES.map(s => s.key), ['creating', 'uploading', 'verifying', 'saving'])
  })

  test('each has the wording the screen shows', () => {
    assert.equal(saveStageLabel('creating'), 'Creating draft')
    assert.equal(saveStageLabel('uploading'), 'Uploading PI')
    assert.equal(saveStageLabel('verifying'), 'Verifying PI')
    assert.equal(saveStageLabel('saving'), 'Saving products and images')
  })

  test('positions are 1-based, for "step 2 of 4"', () => {
    assert.equal(saveStageIndex('creating'), 1)
    assert.equal(saveStageIndex('saving'), 4)
    assert.equal(SAVE_STAGES.length, 4)
  })

  test('verification comes before saving, because the server decides', () => {
    const keys = SAVE_STAGES.map(s => s.key)
    assert.ok(keys.indexOf('verifying') < keys.indexOf('saving'))
    assert.ok(keys.indexOf('uploading') < keys.indexOf('verifying'))
  })
})

// ── Failures ──────────────────────────────────────────────────────────────────

describe('describeSaveFailure', () => {
  test('a transport or storage failure is retryable', () => {
    for (const code of ['NETWORK', 'UPLOAD_FAILED', 'SAVE_FAILED', 'IMAGE_UPLOAD_FAILED', 'CREATE_FAILED']) {
      assert.equal(describeSaveFailure(code).retryable, true, code)
    }
  })

  test('an authorization failure is NOT retryable', () => {
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'ACCOUNT_INACTIVE', 'NOT_OWNED', 'NOT_EDITABLE']) {
      assert.equal(describeSaveFailure(code).retryable, false, code)
    }
  })

  test('a server rejection of the DOCUMENT is flagged as such', () => {
    for (const code of ['PARSE_FAILED', 'BLOCKING_ISSUES']) {
      const failure = describeSaveFailure(code)
      assert.equal(failure.serverRejectedDocument, true, code)
      assert.equal(failure.retryable, false, 'pressing save again cannot fix the workbook')
    }
  })

  test('a transport failure is NOT a document rejection', () => {
    assert.equal(describeSaveFailure('NETWORK').serverRejectedDocument, false)
    assert.equal(describeSaveFailure('SAVE_FAILED').serverRejectedDocument, false)
  })

  test('a busy draft is retryable and says so in plain words', () => {
    const busy = describeSaveFailure('PROCESSING_BUSY')
    assert.equal(busy.retryable, true)
    assert.equal(busy.serverRejectedDocument, false, 'nothing is wrong with the PI')
    assert.equal(busy.message, 'This draft is already being processed. Please try again shortly.')
  })

  test('a lease problem and an image integrity problem are both retryable', () => {
    assert.equal(describeSaveFailure('LEASE_FAILED').retryable, true)
    const integrity = describeSaveFailure('IMAGE_INTEGRITY')
    assert.equal(integrity.retryable, true)
    assert.equal(integrity.serverRejectedDocument, false)
  })

  test('a busy draft does not stop the employee saving later', () => {
    // The gate depends on the preview and the in-flight flag, never on the
    // last failure — so a busy response leaves the button live for a retry.
    assert.equal(canSaveDraft(gate()), true)
  })

  test('an unknown code is retryable rather than declared fatal', () => {
    const failure = describeSaveFailure('SOMETHING_NEW')
    assert.equal(failure.retryable, true)
    assert.equal(failure.code, 'SOMETHING_NEW')
    assert.equal(failure.serverRejectedDocument, false)
  })

  test('a missing code still produces something safe to show', () => {
    assert.equal(describeSaveFailure(null).code, 'UNKNOWN')
    assert.equal(describeSaveFailure(undefined).code, 'UNKNOWN')
    assert.equal(describeSaveFailure('').code, 'UNKNOWN')
  })

  test('no message leaks workbook content', () => {
    for (const code of ['PARSE_FAILED', 'BLOCKING_ISSUES', 'SAVE_FAILED', 'UNKNOWN']) {
      const { message } = describeSaveFailure(code)
      assert.ok(!/₹/.test(message))
      assert.ok(!/\d{4,}/.test(message), 'no figures in a failure message')
    }
  })
})

// ── Success ───────────────────────────────────────────────────────────────────

describe('summariseSaveResult', () => {
  const response = {
    submissionId: SUBMISSION,
    itemCount: 12,
    representativeImageCount: 12,
    customizationImageCount: 4,
    warningCodes: ['LINE_TOTAL_MISMATCH'],
  }

  test('reports what the SERVER saved', () => {
    const result = summariseSaveResult(response, 'fallback')
    assert.equal(result.submissionId, SUBMISSION)
    assert.equal(result.itemCount, 12)
    assert.equal(result.representativeImageCount, 12)
    assert.equal(result.customizationImageCount, 4)
    assert.equal(result.summary, '12 products · 12 representative images · 4 customization images')
  })

  test('never claims an order number', () => {
    const result = summariseSaveResult(response, 'fallback')
    assert.equal(result.orderNumberAssigned, false)
    assert.equal(result.note, SAVE_SUCCESS_NO_NUMBER_NOTE)
    assert.ok(/no official order number/i.test(result.note))
    assert.ok(/approval/i.test(result.note))
    assert.ok(!/order number [A-Z0-9]/i.test(result.summary))
  })

  test('the summary omits customization images when there are none', () => {
    const result = summariseSaveResult({ ...response, customizationImageCount: 0 }, 'fallback')
    assert.equal(result.summary, '12 products · 12 representative images')
    assert.ok(!result.summary.includes('customization'))
  })

  test('singulars read correctly', () => {
    const result = summariseSaveResult(
      { ...response, itemCount: 1, representativeImageCount: 1, customizationImageCount: 1 },
      'fallback',
    )
    assert.equal(result.summary, '1 product · 1 representative image · 1 customization image')
  })

  test('the browser’s own counts are not used — only the response is read', () => {
    // A server that saved 11 of 12 lines is reported as 11. The screen must
    // show what was SAVED, not what the preview happened to show.
    const result = summariseSaveResult({ ...response, itemCount: 11 }, 'fallback')
    assert.equal(result.itemCount, 11)
    assert.ok(result.summary.startsWith('11 products'))
  })

  test('a malformed response degrades to zeroes rather than to nonsense', () => {
    const result = summariseSaveResult({}, SUBMISSION)
    assert.equal(result.itemCount, 0)
    assert.equal(result.representativeImageCount, 0)
    assert.equal(result.submissionId, SUBMISSION, 'the fallback id is used')
    assert.deepEqual(result.warningCodes, [])
    assert.equal(result.orderNumberAssigned, false)
  })

  test('non-numeric or negative counts are refused', () => {
    const result = summariseSaveResult(
      { itemCount: -3, representativeImageCount: 'many', customizationImageCount: null },
      SUBMISSION,
    )
    assert.equal(result.itemCount, 0)
    assert.equal(result.representativeImageCount, 0)
    assert.equal(result.customizationImageCount, 0)
  })

  test('warning codes are kept as codes, and non-strings are dropped', () => {
    const result = summariseSaveResult({ ...response, warningCodes: ['A', 3, null, 'B'] }, 'x')
    assert.deepEqual(result.warningCodes, ['A', 'B'])
  })
})

// ── The upload key ────────────────────────────────────────────────────────────

describe('workbookObjectPath', () => {
  test('is the key the server will accept for this draft', () => {
    const path = workbookObjectPath(SUBMISSION, OBJECT)
    assert.equal(path, `submissions/${SUBMISSION}/original/${OBJECT}.xlsx`)
    assert.equal(isWorkbookPathFor(path, SUBMISSION), true)
  })

  test('a key built for one draft is refused for another', () => {
    const path = workbookObjectPath(SUBMISSION, OBJECT)
    assert.equal(isWorkbookPathFor(path, '99999999-8888-4777-8666-555555555555'), false)
  })

  test('carries no filename, so no client name reaches an object key', () => {
    const path = workbookObjectPath(SUBMISSION, OBJECT)
    assert.ok(!path.includes(' '))
    assert.match(path, /\/original\/[0-9a-f-]{36}\.xlsx$/)
  })

  test('the upload declares the OOXML type the bucket allows', () => {
    assert.equal(
      WORKBOOK_UPLOAD_MIME,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })
})

describe('an unsupported image format is a document rejection', () => {
  test('IMAGE_FORMAT_UNSUPPORTED is not retryable and names the fix', () => {
    const failure = describeSaveFailure('IMAGE_FORMAT_UNSUPPORTED')
    assert.equal(failure.serverRejectedDocument, true, 'the workbook is what must change')
    assert.equal(failure.retryable, false, 'pressing save again cannot help')
    assert.ok(/PNG, JPG\/JPEG or WebP/.test(failure.message))
  })

  test('it is distinguishable from a transport failure', () => {
    assert.equal(describeSaveFailure('IMAGE_UPLOAD_FAILED').serverRejectedDocument, false)
    assert.equal(describeSaveFailure('IMAGE_FORMAT_UNSUPPORTED').serverRejectedDocument, true)
  })

  test('a save can never silently succeed with images missing', () => {
    // The success shape carries no "skipped" concept at all: anything the
    // server could not store stops the save instead of shrinking it.
    const result = summariseSaveResult(
      { submissionId: 'x', itemCount: 12, representativeImageCount: 12, customizationImageCount: 4 },
      'x',
    )
    assert.ok(!('skippedImageCount' in result))
    assert.ok(!/skip/i.test(result.summary))
  })
})
