/**
 * Editing the attachments of a SUBMITTED Order Request — what the reader is told
 * when it fails.
 *
 * WHY THIS EXISTS: every failure of this save used to arrive as one sentence,
 * "Could not save the attachment changes. Nothing was changed — please try
 * again." That sentence was shown for a rejected file, for a lost permission,
 * for a concurrent edit, and — the case that actually happened — for a database
 * that did not yet have the migration this feature depends on. Four different
 * problems with four different remedies, reported identically, which is why the
 * real cause took a code read to place instead of a glance at the screen.
 *
 * SCOPE, STATED HONESTLY: the route's orchestration (upload → RPC → cleanup)
 * needs Storage and PostgREST and cannot run here. What IS asserted is the pure
 * mapping the route uses for its message, plus the discipline that matters most
 * in an audit-bearing flow: "Nothing was changed" is a factual claim, and it
 * must never appear where the outcome is unknown. The server-side refusals
 * themselves are covered by supabase/tests + the RPC's own raises.
 *
 * Run:
 *   npx tsx --test src/lib/orderRequestAttachmentEdit.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachmentEditErrorMessage,
  buildAttachmentPath,
  resolveUploadType,
  ORDER_REQ_ATTACHMENT_BUCKET,
} from './orderRequestAttachments'
import { ORDER_REQ_ATTACHMENT_BUCKET as SERVER_BUCKET } from './orderRequestAttachmentsServer'

// A DOM-free stand-in for a picked file. Only the two properties the pure
// helpers read (name, type) are needed, so no Blob or FileReader is involved.
function picked(name: string, type = ''): File {
  return { name, type } as File
}

const REQUEST_ID = '28beebd1-c69d-4439-b30c-5fd95690362c'

describe('where a replacement reference file is written', () => {
  test('the browser and the server route agree on one private bucket', () => {
    // The route imports the name from the SERVER module and the browser helpers
    // from the client one. Two constants, one bucket — asserted rather than
    // assumed, because a replacement written to the wrong bucket would upload
    // cleanly and then be unreadable.
    assert.equal(ORDER_REQ_ATTACHMENT_BUCKET, 'order-request-attachments')
    assert.equal(SERVER_BUCKET, ORDER_REQ_ATTACHMENT_BUCKET)
  })

  test('the request id is the FIRST path segment, which is what storage RLS reads', () => {
    const path = buildAttachmentPath(REQUEST_ID, 'reference', 'quotation.pdf')
    assert.equal(path.split('/')[0], REQUEST_ID)
    assert.equal(path.split('/')[1], 'references')
    assert.match(path, /quotation\.pdf$/)
  })

  test('the two categories are written to their own folders', () => {
    assert.match(buildAttachmentPath(REQUEST_ID, 'main_pi',  'pi.xlsx'), /^[^/]+\/main-pi\//)
    assert.match(buildAttachmentPath(REQUEST_ID, 'reference', 'doc.pdf'), /^[^/]+\/references\//)
  })

  test('two files of the same name never collide', () => {
    const a = buildAttachmentPath(REQUEST_ID, 'reference', 'drawing.pdf')
    const b = buildAttachmentPath(REQUEST_ID, 'reference', 'drawing.pdf')
    assert.notEqual(a, b)
  })

  test('spaces and special characters never reach the object key raw', () => {
    const path = buildAttachmentPath(REQUEST_ID, 'reference', 'Site Plan (rev 2) — final #3.pdf')
    const leaf = path.split('/').pop() as string
    // The key is safe: no spaces, no path traversal, no shell/URL punctuation.
    assert.doesNotMatch(leaf, /[\s()#—]/)
    assert.doesNotMatch(path, /\.\./)
    // The extension survives, so the stored object still opens as a PDF.
    assert.match(leaf, /\.pdf$/)
    // Still only three segments — a name cannot inject a folder.
    assert.equal(buildAttachmentPath(REQUEST_ID, 'reference', 'a/b/../evil.pdf').split('/').length, 3)
  })

  test('a fully non-ASCII filename still produces a usable, addressable key', () => {
    const path = buildAttachmentPath(REQUEST_ID, 'reference', 'ग्राहक-नोट.pdf')
    const leaf = path.split('/').pop() as string
    // DOCUMENTED, and deliberately not asserted as keeping ".pdf": every
    // character of that name is stripped by sanitizeFileName, so the extension
    // is absorbed into the collapse and the key ends "-pdf" rather than ".pdf".
    // That is cosmetic and confined to the OBJECT KEY. The user-visible name is
    // order_request_attachments.file_name, which stores the ORIGINAL filename
    // untouched, and the content type is set explicitly on upload — so preview,
    // download and type handling are all unaffected. What must hold is that the
    // key is non-empty, unique and correctly scoped, which is what is asserted.
    assert.equal(path.split('/')[0], REQUEST_ID)
    assert.ok(leaf.length > 0)
    assert.notEqual(buildAttachmentPath(REQUEST_ID, 'reference', 'ग्राहक-नोट.pdf'), path)
  })
})

describe('which replacement files are accepted at all', () => {
  test('an accepted reference type resolves to its canonical mime', () => {
    assert.equal(resolveUploadType(picked('quote.pdf', 'application/pdf'), 'reference'), 'application/pdf')
    assert.equal(resolveUploadType(picked('photo.JPG', 'image/jpeg'), 'reference'), 'image/jpeg')
    // A blank browser type is tolerated — the extension is the gate.
    assert.equal(resolveUploadType(picked('notes.docx'), 'reference'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  test('an unsupported type is refused before anything is uploaded', () => {
    assert.equal(resolveUploadType(picked('payload.exe', 'application/x-msdownload'), 'reference'), null)
    assert.equal(resolveUploadType(picked('archive.zip', 'application/zip'), 'reference'), null)
    // A double extension is judged on the LAST one.
    assert.equal(resolveUploadType(picked('invoice.pdf.exe'), 'reference'), null)
    // A dangerous ext↔type mismatch is refused even though .pdf is allowed.
    assert.equal(resolveUploadType(picked('invoice.pdf', 'application/x-msdownload'), 'reference'), null)
  })

  test('the Main PI stays Excel-only, and a reference PDF cannot become one', () => {
    assert.equal(resolveUploadType(picked('pi.pdf', 'application/pdf'), 'main_pi'), null)
    assert.equal(resolveUploadType(picked('pi.xlsx'), 'main_pi'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })
})

describe('the message names what refused', () => {
  test('a database without the migration is reported as a server that is not ready', () => {
    // The failure the user hit: edit_order_request_attachments does not exist, so
    // PostgREST cannot resolve it. Nothing about the user's FILE is wrong, and no
    // amount of retrying will help, so the message must not suggest either.
    const msg = attachmentEditErrorMessage({
      code: 'PGRST202',
      message: 'Could not find the function public.edit_order_request_attachments(...) in the schema cache',
    })
    assert.match(msg, /not available on this server yet/)
    assert.match(msg, /administrator/)
    // Never leaks the function name, the schema or the SQLSTATE.
    assert.doesNotMatch(msg, /edit_order_request_attachments|public\.|schema cache|PGRST/)
  })

  test('a missing function is recognised from the message alone', () => {
    // Some transports drop the code and keep only the text.
    const msg = attachmentEditErrorMessage({ message: 'could not find the function in the schema cache' })
    assert.match(msg, /not available on this server yet/)
  })

  test('a rejected Main PI names the file rule, not a retry', () => {
    const msg = attachmentEditErrorMessage({
      code: 'P0001', message: 'MAIN_PI_NOT_EXCEL: the Main PI must be an Excel file (.xlsx or .xls).',
    })
    assert.match(msg, /must be an Excel file/)
    assert.doesNotMatch(msg, /MAIN_PI_NOT_EXCEL/)
  })

  test('an unreadable new reference file is distinguished from a save failure', () => {
    const msg = attachmentEditErrorMessage({
      code: 'P0001', message: 'ATTACHMENT_INVALID: one of the new files is incomplete.',
    })
    assert.match(msg, /could not be read/)
    assert.match(msg, /Choose it again/)
    assert.doesNotMatch(msg, /ATTACHMENT_INVALID/)
  })

  test('a permission refusal reads as a permission refusal', () => {
    const byCode = attachmentEditErrorMessage({ code: '42501', message: 'something opaque' })
    assert.match(byCode, /do not have permission/)
    const byText = attachmentEditErrorMessage({
      message: 'You do not have permission to change the attachments on this Order Request.',
    })
    assert.match(byText, /do not have permission/)
  })

  test('a converted or otherwise locked request says the door is closed', () => {
    const msg = attachmentEditErrorMessage({
      code: '42501',
      message: 'ATTACHMENTS_LOCKED: this Order Request has been converted and its attachments can no longer be changed.',
    })
    assert.match(msg, /can no longer have its attachments changed/)
  })

  test('a stale removal tells the reader to refresh', () => {
    const msg = attachmentEditErrorMessage({
      code: 'P0002', message: 'ATTACHMENT_NOT_FOUND: one of the selected files no longer belongs to this Order Request.',
    })
    assert.match(msg, /no longer belongs/)
    assert.match(msg, /Refresh/)
  })

  test('the Main PI invariant is reported as the rule it is', () => {
    const msg = attachmentEditErrorMessage({
      code: 'P0001', message: 'MAIN_PI_REQUIRED: a submitted Order Request must always have exactly one Main PI.',
    })
    assert.match(msg, /must always have a Main PI/)
  })

  test('only a genuine 40001/55P03 is reported as a concurrent change', () => {
    assert.match(
      attachmentEditErrorMessage({ code: '40001', message: 'could not serialize access' }),
      /Someone else is changing this Order Request/,
    )
    assert.match(
      attachmentEditErrorMessage({ code: '55P03', message: 'lock not available' }),
      /Someone else is changing this Order Request/,
    )
    // A plain server error must NOT claim a conflict — that sends the reader
    // hunting for a phantom edit (the lesson recorded in 20260709).
    assert.doesNotMatch(
      attachmentEditErrorMessage({ code: 'XX000', message: 'internal error' }),
      /Someone else/,
    )
  })
})

describe('"Nothing was changed" is a factual claim', () => {
  const CASES: { name: string; err: { code?: string; message?: string } }[] = [
    { name: 'missing function',   err: { code: 'PGRST202', message: 'schema cache' } },
    { name: 'rejected Main PI',   err: { code: 'P0001', message: 'MAIN_PI_NOT_EXCEL: ...' } },
    { name: 'invalid attachment', err: { code: 'P0001', message: 'ATTACHMENT_INVALID: ...' } },
    { name: 'locked request',     err: { code: '42501', message: 'ATTACHMENTS_LOCKED: ...' } },
    { name: 'stale removal',      err: { code: 'P0002', message: 'ATTACHMENT_NOT_FOUND: ...' } },
    { name: 'permission',         err: { code: '42501', message: 'permission' } },
    { name: 'concurrent edit',    err: { code: '40001', message: 'could not serialize access' } },
    { name: 'unmapped failure',   err: { code: 'XX000', message: 'boom' } },
  ]

  for (const c of CASES) {
    test(`${c.name}: the claim is allowed, because the transaction rolled back`, () => {
      // Every branch here is reached only after the metadata RPC failed, which
      // means the transaction rolled back in full and the route removed the
      // objects it had uploaded. The record really is untouched.
      assert.match(attachmentEditErrorMessage(c.err).toLowerCase(), /nothing was (changed|saved)/)
    })
  }

  test('an empty request is the one case that leads with nothing saved', () => {
    const msg = attachmentEditErrorMessage({
      code: 'P0001', message: 'NO_ATTACHMENT_CHANGES: no attachment changes were supplied.',
    })
    assert.match(msg, /^No attachment changes were supplied/)
    assert.doesNotMatch(msg, /try again/)
  })

  test('no branch exposes internals', () => {
    for (const c of [...CASES, { name: 'empty', err: { code: 'P0001', message: 'NO_ATTACHMENT_CHANGES: x' } }]) {
      const msg = attachmentEditErrorMessage(c.err)
      assert.doesNotMatch(msg, /P0001|P0002|42501|40001|55P03|PGRST|SQLSTATE|edit_order_request/)
      // No storage path, bucket name or signed URL.
      assert.doesNotMatch(msg, /order-request-attachments|references\/|main-pi\/|https?:/)
    }
  })
})
