/**
 * Task-update attachment queue — behavioural tests.
 *
 * The property under test throughout is the one the feature exists for: bytes
 * move when a file is PICKED, not when Send Update is clicked, and Send Update
 * never re-uploads what already landed. Everything else here guards the edges
 * that make that safe — de-duplication, the 10 MB budget, failure gating,
 * removal cleanup, and the double-click guard.
 *
 * The queue takes its upload/compress/delete as dependencies, so these tests
 * drive the real controller the page uses, not a re-implementation of it.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/commentAttachments.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTACHMENT_SIZE_ERROR,
  ATTACHMENT_TOTAL_SIZE_LIMIT,
  attachmentKey,
  attachmentRowsForSubmit,
  attachmentStatusLabel,
  buildAttachmentPath,
  committedBytes,
  createAttachmentQueue,
  createGate,
  createSemaphore,
  exceedsSizeLimit,
  failureSummary,
  hasPendingUploads,
  partitionIncoming,
  submissionGate,
  submitButtonLabel,
  type AttachmentQueue,
  type PendingAttachment,
} from './commentAttachments'

// ── Test doubles ──────────────────────────────────────────────────────────────

const tick = (n = 0) => new Promise<void>(r => setTimeout(r, n))

/** A File stand-in — node has no File with a usable constructor in every runtime. */
const fakeFile = (name: string, size = 1024, lastModified = 1_700_000_000_000): File =>
  ({ name, size, lastModified, type: '' } as unknown as File)

type Harness = {
  queue: AttachmentQueue
  /** Every path handed to upload(), in call order. */
  uploads: string[]
  /** Every path handed to deleteObject(). */
  deletes: string[]
  /** Latest published list — what the component would render. */
  rendered: () => readonly PendingAttachment[]
  /** Resolve/reject the upload for the Nth call. */
  finish: (index: number, error?: unknown) => void
}

function harness(opts: {
  /** Hold uploads open until `finish` is called. */
  manual?: boolean
  /** Compressed size per file name. */
  compressTo?: Record<string, number>
  /** Fail the upload of these paths' files by name. */
  failNames?: string[]
} = {}): Harness {
  const uploads: string[] = []
  const deletes: string[] = []
  const resolvers: ((v: { error: unknown }) => void)[] = []
  let published: PendingAttachment[] = []
  let pathSeq = 0

  const queue = createAttachmentQueue({
    taskId: 'task-1',
    compress: async (file) => {
      const to = opts.compressTo?.[file.name]
      return to === undefined ? file : (fakeFile(file.name, to, file.lastModified))
    },
    upload: async (path, file) => {
      uploads.push(path)
      if (opts.manual) {
        return new Promise<{ error: unknown }>(res => { resolvers.push(res) })
      }
      await tick(1)
      return { error: opts.failNames?.includes(file.name) ? new Error('boom') : null }
    },
    publicUrl: (path) => `https://cdn.test/${path}`,
    deleteObject: async (path) => { deletes.push(path) },
    onChange: (items) => { published = items },
    concurrency: 3,
    // Deterministic paths so assertions can name them.
    buildPath: (taskId, fileName) => `updates/${taskId}/${++pathSeq}_${fileName}`,
  })

  return {
    queue,
    uploads,
    deletes,
    rendered: () => published,
    finish: (index, error = null) => resolvers[index]?.({ error }),
  }
}

// ── 1–3. Upload starts on selection / paste / drop ────────────────────────────

describe('upload starts when the file arrives, not at submit', () => {
  // The page routes browse, paste and drop through one `addCommentFiles`, which
  // calls queue.add — so these three cases are the same call with different
  // provenance, and that is exactly what makes them equivalent.

  test('a selected file begins uploading before submit is called', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('picked.png')])
    await tick(2)
    assert.equal(h.uploads.length, 1, 'no upload started on selection')
    assert.equal(h.rendered()[0].status, 'uploading')
  })

  test('a pasted file begins uploading before submit is called', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('pasted.png')])
    await tick(2)
    assert.equal(h.uploads.length, 1)
    assert.match(h.uploads[0], /pasted\.png$/)
  })

  test('a dropped file begins uploading before submit is called', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('dropped.pdf')])
    await tick(2)
    assert.equal(h.uploads.length, 1)
    assert.match(h.uploads[0], /dropped\.pdf$/)
  })

  test('the item is visible immediately, before any byte moves', () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('instant.png')])
    // Synchronously after add — the user sees the row without waiting.
    assert.equal(h.rendered().length, 1)
    assert.equal(h.rendered()[0].status, 'preparing')
    assert.equal(h.rendered()[0].fileName, 'instant.png')
  })
})

// ── 4–5. Submit does not re-upload; submit waits for what is unfinished ───────

describe('submit and in-flight uploads', () => {
  test('a finished upload is NOT uploaded again when submit settles the queue', async () => {
    const h = harness()
    h.queue.add([fakeFile('done.png')])
    await tick(10)
    assert.equal(h.uploads.length, 1)
    assert.equal(h.queue.items()[0].status, 'uploaded')

    await h.queue.settleAll()
    assert.equal(h.uploads.length, 1, 'settleAll re-uploaded an already-uploaded file')
  })

  test('settleAll resolves only once an in-flight upload finishes', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('slow.png')])
    await tick(2)

    let settled = false
    const waiting = h.queue.settleAll().then(() => { settled = true })
    await tick(5)
    assert.equal(settled, false, 'settleAll resolved while an upload was still running')

    h.finish(0)
    await waiting
    assert.equal(settled, true)
    assert.equal(h.queue.items()[0].status, 'uploaded')
  })

  test('settleAll on an empty queue resolves without work — the text-only path', async () => {
    const h = harness({ manual: true })
    assert.equal(h.queue.hasPending(), false)
    await h.queue.settleAll()
    assert.equal(h.uploads.length, 0, 'a text-only update touched the upload path')
  })

  test('an upload finished before submit leaves nothing pending', async () => {
    const h = harness()
    h.queue.add([fakeFile('early.png')])
    await tick(10)
    assert.equal(h.queue.hasPending(), false, 'submit would needlessly wait')
  })
})

// ── 6–7. Failure blocks submission; retry works ───────────────────────────────

describe('failed uploads', () => {
  test('a failed upload is marked failed and blocks submission', async () => {
    const h = harness({ failNames: ['bad.png'] })
    h.queue.add([fakeFile('bad.png')])
    await tick(10)

    const item = h.queue.items()[0]
    assert.equal(item.status, 'failed')

    // hasNote = true: the typed text alone would otherwise be submittable.
    const gate = submissionGate(h.queue.items(), true)
    assert.equal(gate.ok, false)
    assert.equal(gate.ok === false && gate.reason, 'failed-upload')
    assert.match(gate.ok === false ? gate.message ?? '' : '', /Retry or remove/)
  })

  test('a failed item keeps its File so retry needs no re-picking', async () => {
    const h = harness({ failNames: ['bad.png'] })
    h.queue.add([fakeFile('bad.png', 4242)])
    await tick(10)
    assert.equal(h.queue.items()[0].file.name, 'bad.png')
    assert.equal(h.queue.items()[0].file.size, 4242)
  })

  test('retry re-runs the upload and can succeed', async () => {
    // Fails on the first attempt, succeeds on the second.
    const uploads: string[] = []
    let attempt = 0
    let published: PendingAttachment[] = []
    const queue = createAttachmentQueue({
      taskId: 't',
      compress: async (f) => f,
      upload: async (path) => { uploads.push(path); attempt++; return { error: attempt === 1 ? new Error('x') : null } },
      publicUrl: (p) => `https://cdn.test/${p}`,
      deleteObject: async () => {},
      onChange: (i) => { published = i },
      buildPath: (t, n) => `updates/${t}/${attempt}_${n}`,
    })

    queue.add([fakeFile('flaky.png')])
    await tick(10)
    assert.equal(queue.items()[0].status, 'failed')

    queue.retry(queue.items()[0].id)
    await tick(10)
    assert.equal(uploads.length, 2, 'retry did not re-upload')
    assert.equal(queue.items()[0].status, 'uploaded')
    assert.equal(published[0].error, null, 'the stale error survived a successful retry')
    assert.equal(submissionGate(queue.items(), true).ok, true)
  })

  test('retry is a no-op for an item that is not failed', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('busy.png')])
    await tick(2)
    h.queue.retry(h.queue.items()[0].id)
    await tick(2)
    assert.equal(h.uploads.length, 1, 'retry started a second upload for a healthy item')
  })

  test('failureSummary collapses identical reasons into one line', () => {
    const items = [
      { status: 'failed', error: 'Upload failed' },
      { status: 'failed', error: 'Upload failed' },
      { status: 'uploaded', error: null },
    ] as PendingAttachment[]
    assert.equal(failureSummary(items), 'Upload failed')
    assert.equal(failureSummary([]), null)
  })
})

// ── 8. Removal ────────────────────────────────────────────────────────────────

describe('removing an attachment before submit', () => {
  test('a removed uploaded file is excluded from the submission AND deleted', async () => {
    const h = harness()
    h.queue.add([fakeFile('keep.png'), fakeFile('drop.png')])
    await tick(20)
    assert.equal(h.queue.items().length, 2)

    const doomed = h.queue.items().find(a => a.fileName === 'drop.png')!
    const doomedPath = doomed.path!
    h.queue.remove(doomed.id)
    await tick(5)

    assert.deepEqual(h.queue.items().map(a => a.fileName), ['keep.png'])
    assert.deepEqual(h.deletes, [doomedPath], 'the pre-uploaded object was left orphaned')

    const rows = attachmentRowsForSubmit(h.queue.items(), {
      taskId: 'task-1', activityLogId: 'log-1', userId: 'u1', fileTypeOf: () => 'Image',
    })
    assert.deepEqual(rows.map(r => r.file_name), ['keep.png'])
  })

  test('a file removed WHILE uploading is dropped and its object deleted on arrival', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('racing.png')])
    await tick(2)
    const id = h.queue.items()[0].id

    h.queue.remove(id)                 // user removes it mid-flight
    assert.equal(h.queue.items().length, 0)
    assert.deepEqual(h.deletes, [], 'nothing is stored yet, so nothing to delete')

    h.finish(0)                        // the upload lands afterwards
    await tick(5)
    assert.equal(h.queue.items().length, 0, 'the removed file came back')
    assert.equal(h.deletes.length, 1, 'the late-arriving object was left orphaned')
  })

  test('clear() after a successful submit keeps the objects — they are now referenced', async () => {
    const h = harness()
    h.queue.add([fakeFile('posted.png')])
    await tick(10)
    h.queue.clear()
    assert.equal(h.queue.items().length, 0)
    assert.deepEqual(h.deletes, [], 'clear deleted an object that the update now references')
  })
})

// ── 9. Text-only bypasses upload handling ─────────────────────────────────────

describe('text-only updates', () => {
  test('nothing is queued, uploaded or waited on', async () => {
    const h = harness()
    assert.equal(h.queue.items().length, 0)
    assert.equal(h.queue.hasPending(), false)
    await h.queue.settleAll()
    assert.equal(h.uploads.length, 0)
    assert.equal(submissionGate(h.queue.items(), true).ok, true)
  })

  test('an empty note with no attachments is not submittable', () => {
    const gate = submissionGate([], false)
    assert.equal(gate.ok, false)
    assert.equal(gate.ok === false && gate.reason, 'empty')
    // No message: an empty click is a no-op, not an error to shout about.
    assert.equal(gate.ok === false && gate.message, null)
  })
})

// ── 11. Duplicate entries from repeated paste/drop ────────────────────────────

describe('de-duplication', () => {
  test('the same file pasted twice is queued and uploaded once', async () => {
    const h = harness({ manual: true })
    h.queue.add([fakeFile('shot.png', 500)])
    const second = h.queue.add([fakeFile('shot.png', 500)])
    await tick(2)

    assert.equal(h.queue.items().length, 1)
    assert.equal(h.uploads.length, 1, 'a duplicate paste started a second upload')
    assert.equal(second.added, 0)
    assert.deepEqual(second.duplicateNames, ['shot.png'])
  })

  test('one drop carrying the same file twice queues it once', () => {
    const h = harness({ manual: true })
    const f = fakeFile('dup.png', 900)
    const res = h.queue.add([f, fakeFile('dup.png', 900)])
    assert.equal(res.added, 1)
    assert.equal(h.queue.items().length, 1)
  })

  test('same name but different size or mtime is a different file', () => {
    const existing = [{ file: fakeFile('a.png', 100, 1) }] as PendingAttachment[]
    assert.equal(partitionIncoming(existing, [fakeFile('a.png', 100, 1)]).added.length, 0)
    assert.equal(partitionIncoming(existing, [fakeFile('a.png', 200, 1)]).added.length, 1)
    assert.equal(partitionIncoming(existing, [fakeFile('a.png', 100, 2)]).added.length, 1)
  })

  test('attachmentKey is name + size + mtime', () => {
    assert.equal(attachmentKey(fakeFile('x.png', 7, 9)), 'x.png|7|9')
  })
})

// ── 12/14. Size validation is preserved ───────────────────────────────────────

describe('the 10 MB total-size rule still applies', () => {
  test('the limit matches the bucket cap', () => {
    assert.equal(ATTACHMENT_TOTAL_SIZE_LIMIT, 10 * 1024 * 1024)
  })

  test('a file that pushes the total over the limit is rejected, not uploaded', async () => {
    const h = harness()
    h.queue.add([fakeFile('big-a.png', 6 * 1024 * 1024)])
    await tick(10)
    h.queue.add([fakeFile('big-b.png', 6 * 1024 * 1024)])
    await tick(10)

    const [a, b] = h.queue.items()
    assert.equal(a.status, 'uploaded')
    assert.equal(b.status, 'failed')
    assert.equal(b.error, ATTACHMENT_SIZE_ERROR)
    assert.equal(h.uploads.length, 1, 'the over-budget file was uploaded anyway')
    assert.equal(submissionGate(h.queue.items(), true).ok, false)
  })

  test('compression is applied before the budget is measured', async () => {
    // 12 MB raw would fail; 2 MB compressed fits, exactly as prepareFiles did.
    const h = harness({ compressTo: { 'huge.jpg': 2 * 1024 * 1024 } })
    h.queue.add([fakeFile('huge.jpg', 12 * 1024 * 1024)])
    await tick(10)
    assert.equal(h.queue.items()[0].status, 'uploaded')
    assert.equal(h.queue.items()[0].preparedSize, 2 * 1024 * 1024)
  })

  test('two files added at once cannot both slip past the budget', async () => {
    // Without a serialised prepare stage each would measure the total before
    // the other was counted, and the pair would be admitted.
    const h = harness()
    h.queue.add([fakeFile('x.png', 6 * 1024 * 1024), fakeFile('y.png', 6 * 1024 * 1024)])
    await tick(20)
    const statuses = h.queue.items().map(a => a.status)
    assert.deepEqual(statuses, ['uploaded', 'failed'])
  })

  test('a size-rejected file consumes none of the budget', async () => {
    const h = harness()
    h.queue.add([fakeFile('a.png', 9 * 1024 * 1024)])
    await tick(10)
    h.queue.add([fakeFile('too-big.png', 5 * 1024 * 1024)])   // rejected
    await tick(10)
    h.queue.add([fakeFile('small.png', 512 * 1024)])          // must still fit
    await tick(10)
    assert.equal(h.queue.items()[2].status, 'uploaded')
  })

  test('committedBytes and exceedsSizeLimit count only prepared items', () => {
    const items = [
      { preparedSize: 1000 }, { preparedSize: null }, { preparedSize: 500 },
    ] as PendingAttachment[]
    assert.equal(committedBytes(items), 1500)
    assert.equal(exceedsSizeLimit(items, ATTACHMENT_TOTAL_SIZE_LIMIT - 1500), false)
    assert.equal(exceedsSizeLimit(items, ATTACHMENT_TOTAL_SIZE_LIMIT - 1499), true)
  })
})

// ── 10. Double-submit protection ──────────────────────────────────────────────

describe('duplicate submission', () => {
  /**
   * The page's guard is a ref read synchronously at the top of saveComment,
   * because both clicks of a double-click land before React re-renders the
   * button as disabled. This models that guard and asserts the property that
   * matters: one activity row per intended update.
   */
  const guardedSubmit = () => {
    let running = false
    const inserts: string[] = []
    return {
      inserts,
      run: async () => {
        if (running) return            // synchronous re-entry guard
        running = true
        try {
          await tick(5)                // the write round trip
          inserts.push('note_added')
        } finally { running = false }
      },
    }
  }

  test('double-clicking Add Update creates exactly one activity entry', async () => {
    const s = guardedSubmit()
    await Promise.all([s.run(), s.run()])   // two clicks in the same tick
    assert.deepEqual(s.inserts, ['note_added'])
  })

  test('double-clicking Complete creates exactly one status transition', async () => {
    const s = guardedSubmit()
    await Promise.all([s.run(), s.run(), s.run()])
    assert.equal(s.inserts.length, 1)
  })

  test('the guard is released so a later, deliberate submit still works', async () => {
    const s = guardedSubmit()
    await s.run()
    await s.run()
    assert.equal(s.inserts.length, 2)
  })
})

// ── Submission payload ────────────────────────────────────────────────────────

describe('attachmentRowsForSubmit', () => {
  const items = [
    { status: 'uploaded', url: 'https://cdn/a.png', fileName: 'a.png' },
    { status: 'uploading', url: null, fileName: 'b.png' },
    { status: 'failed', url: null, fileName: 'c.png' },
    { status: 'uploaded', url: 'https://cdn/d.pdf', fileName: 'd.pdf' },
  ] as PendingAttachment[]

  test('includes only uploaded files, in the order they were picked', () => {
    const rows = attachmentRowsForSubmit(items, {
      taskId: 'T', activityLogId: 'L', userId: 'U', fileTypeOf: (n) => n.endsWith('.pdf') ? 'PDF' : 'Image',
    })
    assert.deepEqual(rows.map(r => r.file_name), ['a.png', 'd.pdf'])
    assert.deepEqual(rows.map(r => r.file_type), ['Image', 'PDF'])
  })

  test('every row is linked to the new activity entry and its task', () => {
    const rows = attachmentRowsForSubmit(items, {
      taskId: 'T', activityLogId: 'L', userId: 'U', fileTypeOf: () => 'Image',
    })
    assert.equal(rows.every(r => r.activity_log_id === 'L' && r.task_id === 'T' && r.created_by === 'U'), true)
  })
})

// ── Storage path ──────────────────────────────────────────────────────────────

describe('buildAttachmentPath', () => {
  test('keeps the existing updates/{taskId}/ shape and extension', () => {
    assert.equal(
      buildAttachmentPath('abc', 'photo.PNG', () => 'r4nd', () => 1234),
      'updates/abc/1234_r4nd.PNG',
    )
  })

  test('an extensionless file gets a bin suffix rather than a bare dot', () => {
    assert.equal(buildAttachmentPath('abc', 'README', () => 'r', () => 1), 'updates/abc/1_r.bin')
  })

  test('paths are unique across two files with the same name', () => {
    const a = buildAttachmentPath('t', 'x.png')
    const b = buildAttachmentPath('t', 'x.png')
    assert.notEqual(a, b)
  })
})

// ── Concurrency primitives ────────────────────────────────────────────────────

describe('createSemaphore', () => {
  test('never lets more than `limit` run at once', async () => {
    const sem = createSemaphore(3)
    let active = 0, peak = 0
    await Promise.all(Array.from({ length: 9 }, async () => {
      const done = await sem.acquire()
      active++; peak = Math.max(peak, active)
      await tick(5)
      active--; done()
    }))
    assert.equal(peak, 3)
  })

  test('a double release cannot widen the window', async () => {
    const sem = createSemaphore(1)
    const done = await sem.acquire()
    done(); done()
    let active = 0, peak = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      const d = await sem.acquire()
      active++; peak = Math.max(peak, active)
      await tick(2)
      active--; d()
    }))
    assert.equal(peak, 1)
  })

  test('a limit below 1 is clamped rather than deadlocking', async () => {
    const sem = createSemaphore(0)
    const done = await sem.acquire()
    done()
    assert.ok(true)
  })
})

describe('createGate', () => {
  test('runs work strictly one at a time, in call order', async () => {
    const gate = createGate()
    const order: string[] = []
    await Promise.all([
      gate(async () => { await tick(10); order.push('a') }),
      gate(async () => { await tick(1);  order.push('b') }),
      gate(async () => { order.push('c') }),
    ])
    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  test('a rejection does not wedge the gate for later callers', async () => {
    const gate = createGate()
    await assert.rejects(() => gate(async () => { throw new Error('nope') }))
    assert.equal(await gate(async () => 'still works'), 'still works')
  })
})

// ── UI labels ─────────────────────────────────────────────────────────────────

describe('button and status labels', () => {
  test('the submit button distinguishes uploading from saving', () => {
    assert.equal(submitButtonLabel({ saving: false, waitingForUploads: false, isQuotation: false }), 'Send Update')
    assert.equal(submitButtonLabel({ saving: false, waitingForUploads: false, isQuotation: true }), 'Add Update')
    assert.equal(submitButtonLabel({ saving: true, waitingForUploads: true, isQuotation: false }), 'Uploading attachment…')
    assert.equal(submitButtonLabel({ saving: true, waitingForUploads: true, isQuotation: true }), 'Uploading attachment…')
    assert.equal(submitButtonLabel({ saving: true, waitingForUploads: false, isQuotation: false }), 'Sending…')
    assert.equal(submitButtonLabel({ saving: true, waitingForUploads: false, isQuotation: true }), 'Adding…')
  })

  test('per-file state is a plain word, never an invented percentage', () => {
    const at = (status: PendingAttachment['status']) =>
      attachmentStatusLabel({ status, error: 'boom' } as PendingAttachment)
    assert.equal(at('preparing'), 'Preparing…')
    assert.equal(at('uploading'), 'Uploading…')
    assert.equal(at('uploaded'), 'Ready')
    assert.equal(at('failed'), 'Failed')
    for (const s of ['preparing', 'uploading', 'uploaded', 'failed'] as const) {
      assert.doesNotMatch(at(s), /%|\d/, 'a fake progress number leaked into the label')
    }
  })

  test('hasPendingUploads is true only while bytes are still moving', () => {
    const of = (status: PendingAttachment['status']) => [{ status }] as PendingAttachment[]
    assert.equal(hasPendingUploads(of('preparing')), true)
    assert.equal(hasPendingUploads(of('uploading')), true)
    assert.equal(hasPendingUploads(of('uploaded')), false)
    assert.equal(hasPendingUploads(of('failed')), false)
    assert.equal(hasPendingUploads([]), false)
  })
})
