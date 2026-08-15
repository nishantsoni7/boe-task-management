// Task-update (comment) attachment queue.
//
// WHY THIS EXISTS
// Attachments used to be plain `File[]` state that was compressed and uploaded
// *inside* the Send Update click handler. A single 3 MB photo therefore put the
// whole compress → upload → metadata round trip between the click and any
// visible result — the ~1 s "click processing" the performance recording showed.
//
// The fix is to move the bytes off the click: the moment a file is selected,
// pasted or dropped it becomes a queue item that compresses and uploads in the
// background while the user keeps typing. Send Update then only waits for
// whatever is still in flight, and never re-uploads a file that already landed.
//
// WHAT IS AND IS NOT PERSISTED EARLY
// Only the STORAGE OBJECT is written ahead of submission. The `task_attachments`
// row — the record the rest of the app reads — is still inserted only after the
// activity-log row for the update exists, so a pre-upload that is never
// submitted is invisible to every query in the product. That is what lets this
// work without a schema change or a new table.
//
// ORPHANED OBJECTS
// Removing an attachment deletes its object, and so does an upload that lands
// after the user already removed it — those are the two cases the queue can
// see. It cannot see the browser tab closing between a finished upload and a
// submit that never happens: that object stays in the bucket, unreferenced by
// any row and therefore invisible in the app, until someone prunes the bucket.
// No cleanup job is introduced here — the project has no such pattern to reuse,
// and inventing one is a larger decision than this change.
//
// Everything here is pure or dependency-injected: no Supabase import, no DOM.
// The page supplies `compress`, `upload` and `remove`, so the whole state
// machine is testable with node:test.

export type PendingAttachmentStatus = 'preparing' | 'uploading' | 'uploaded' | 'failed'

export type PendingAttachment = {
  /** Stable client-side key. Not a database id — nothing is persisted yet. */
  id: string
  /** Original File, retained so a failed upload can be retried without re-picking. */
  file: File
  fileName: string
  /** Bytes shown to the user: the compressed size once known, the raw size before that. */
  size: number
  /**
   * Compressed size, set when the item clears the prepare gate. `null` means the
   * item has not been counted against the 10 MB budget yet.
   */
  preparedSize: number | null
  status: PendingAttachmentStatus
  /** Storage object key, set on a successful upload. Needed to delete on removal. */
  path: string | null
  /** Public URL, set on a successful upload. Written into task_attachments at submit. */
  url: string | null
  error: string | null
}

/** Mirrors the bucket-level cap in 20260607000000_add_task_attachments.sql. */
export const ATTACHMENT_TOTAL_SIZE_LIMIT = 10 * 1024 * 1024

export const ATTACHMENT_SIZE_ERROR =
  'Total attachment size must be under 10 MB. Please remove or reduce files.'

// ── Identity and de-duplication ───────────────────────────────────────────────

/**
 * Identity for de-duplication. A repeated paste or a drop of the same file
 * produces a distinct `File` object with identical metadata, so object identity
 * is useless here — name + size + mtime is what a person means by "the same
 * file". Two genuinely different files that collide on all three are
 * indistinguishable to the user anyway.
 */
export function attachmentKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

/**
 * Split incoming files into the ones to queue and the ones already queued.
 * Also de-duplicates *within* `incoming`, because a drop event can carry the
 * same file twice.
 */
export function partitionIncoming(
  existing: readonly PendingAttachment[],
  incoming: readonly File[],
): { added: File[]; duplicateNames: string[] } {
  const seen = new Set(existing.map(a => attachmentKey(a.file)))
  const added: File[] = []
  const duplicateNames: string[] = []
  for (const file of incoming) {
    const key = attachmentKey(file)
    if (seen.has(key)) { duplicateNames.push(file.name); continue }
    seen.add(key)
    added.push(file)
  }
  return { added, duplicateNames }
}

// ── Size accounting ───────────────────────────────────────────────────────────

/**
 * Bytes already committed to the 10 MB budget: every item that has cleared the
 * prepare gate, whatever its upload state. A failed *upload* still counts —
 * the user intends to retry it, and freeing its budget would let them queue
 * more than the bucket accepts. An item rejected by the gate has no
 * `preparedSize` and so costs nothing.
 */
export function committedBytes(items: readonly PendingAttachment[]): number {
  return items.reduce((sum, a) => sum + (a.preparedSize ?? 0), 0)
}

/** True when adding `candidateBytes` would break the total-size rule. */
export function exceedsSizeLimit(
  items: readonly PendingAttachment[],
  candidateBytes: number,
): boolean {
  return committedBytes(items) + candidateBytes > ATTACHMENT_TOTAL_SIZE_LIMIT
}

// ── List updates ──────────────────────────────────────────────────────────────

export function patchAttachment(
  items: readonly PendingAttachment[],
  id: string,
  patch: Partial<PendingAttachment>,
): PendingAttachment[] {
  return items.map(a => (a.id === id ? { ...a, ...patch } : a))
}

export function removeAttachment(
  items: readonly PendingAttachment[],
  id: string,
): PendingAttachment[] {
  return items.filter(a => a.id !== id)
}

// ── Submission gating ─────────────────────────────────────────────────────────

export type SubmissionGate =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'failed-upload'; message: string | null }

/**
 * Whether Send Update may run. An in-flight upload is NOT a blocker — the
 * caller awaits it — but a failed one is, because submitting would silently
 * drop a file the user believes they attached.
 */
export function submissionGate(
  items: readonly PendingAttachment[],
  hasNote: boolean,
): SubmissionGate {
  if (items.some(a => a.status === 'failed')) {
    return {
      ok: false,
      reason: 'failed-upload',
      message: 'Some attachments did not upload. Retry or remove them before sending.',
    }
  }
  if (!hasNote && items.length === 0) return { ok: false, reason: 'empty', message: null }
  return { ok: true }
}

/** True when at least one item still has bytes to move. Drives the button label. */
export function hasPendingUploads(items: readonly PendingAttachment[]): boolean {
  return items.some(a => a.status === 'preparing' || a.status === 'uploading')
}

export function submitButtonLabel(args: {
  saving: boolean
  waitingForUploads: boolean
  isQuotation: boolean
}): string {
  if (args.saving) return args.waitingForUploads ? 'Uploading attachment…' : (args.isQuotation ? 'Adding…' : 'Sending…')
  return args.isQuotation ? 'Add Update' : 'Send Update'
}

/**
 * Short per-file state shown next to the filename. Deliberately not a
 * percentage: supabase-js `upload()` exposes no reliable byte progress, and a
 * fabricated bar is worse than an honest indeterminate state.
 */
export function attachmentStatusLabel(item: PendingAttachment): string {
  switch (item.status) {
    case 'preparing': return 'Preparing…'
    case 'uploading': return 'Uploading…'
    case 'uploaded':  return 'Ready'
    case 'failed':    return 'Failed'
  }
}

/**
 * The distinct reasons files failed, for one line under the list. Distinct
 * rather than per-file because five oversized files are one problem, not five.
 */
export function failureSummary(items: readonly PendingAttachment[]): string | null {
  const reasons = [...new Set(
    items.filter(a => a.status === 'failed').map(a => a.error ?? 'Upload failed'),
  )]
  return reasons.length > 0 ? reasons.join(' · ') : null
}

// ── Submission payload ────────────────────────────────────────────────────────

export type AttachmentRow = {
  activity_log_id: string
  task_id: string
  /**
   * LEGACY. A public URL, still written because `task_attachments.url` is NOT
   * NULL and the frontend deploys ahead of the migrations. Nothing READS it once
   * `storage_path` is present — see resolveAttachmentPath. It stops resolving
   * when 20260907000000 makes the bucket private, and the column can be dropped
   * after that.
   */
  url: string
  /** The object key. The authority for signing, downloading and deleting. */
  storage_path: string
  file_name: string
  file_type: string
  created_by: string
}

/**
 * The `task_attachments` rows for a successful submit — one bulk insert rather
 * than one round trip per file, since the bytes are already in storage.
 * Only `uploaded` items are included; input order is preserved so attachments
 * render in the order the user picked them.
 */
export function attachmentRowsForSubmit(
  items: readonly PendingAttachment[],
  ctx: { taskId: string; activityLogId: string; userId: string; fileTypeOf: (name: string) => string },
): AttachmentRow[] {
  // `path` is now required as well as `url`: a row without its object key would
  // be unreachable the moment the bucket goes private, which is precisely the
  // state 20260906000000's assertion refuses to allow.
  return items
    .filter(a => a.status === 'uploaded' && a.url && a.path)
    .map(a => ({
      activity_log_id: ctx.activityLogId,
      task_id:         ctx.taskId,
      url:             a.url as string,
      storage_path:    a.path as string,
      file_name:       a.fileName,
      file_type:       ctx.fileTypeOf(a.fileName),
      created_by:      ctx.userId,
    }))
}

// ── Storage path ──────────────────────────────────────────────────────────────

/**
 * Unchanged from the pre-upload implementation: `updates/{taskId}/…`. Keeping
 * the shape means existing objects, the public-read policy and every stored URL
 * keep working, and a pre-uploaded object is indistinguishable from one uploaded
 * at submit time.
 */
export function buildAttachmentPath(
  taskId: string,
  fileName: string,
  rand: () => string = () => Math.random().toString(36).slice(2),
  now: () => number = Date.now,
): string {
  // `split('.').pop()` on a name with no dot returns the whole name, which the
  // old inline version then used as the "extension" — harmless only because
  // extensionless files never pass filterAcceptedFiles. Check for the dot.
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? fileName.slice(dot + 1) : 'bin'
  return `updates/${taskId}/${now()}_${rand()}.${ext}`
}

// ── Concurrency ───────────────────────────────────────────────────────────────

/**
 * Minimal counting semaphore. Uploads now start whenever a file arrives rather
 * than in one batch, so `mapWithConcurrency` (which needs the whole list up
 * front) no longer applies — but the reason for a cap does: a dozen files must
 * not eat the browser's per-host connection budget and stall the page the user
 * is still typing into.
 */
export type Semaphore = { acquire: () => Promise<() => void> }

export function createSemaphore(limit: number): Semaphore {
  const width = Math.max(1, limit)
  let active = 0
  const waiting: (() => void)[] = []

  const release = () => {
    active--
    const next = waiting.shift()
    if (next) next()
  }

  return {
    acquire: () =>
      new Promise<() => void>(resolve => {
        const start = () => {
          active++
          let released = false
          // Idempotent: a double release would inflate the window.
          resolve(() => { if (!released) { released = true; release() } })
        }
        if (active < width) start()
        else waiting.push(start)
      }),
  }
}

/**
 * Serialises work so each caller sees the effects of the previous one. The
 * prepare stage needs this: compression is async, and two files compressing
 * concurrently would each measure the size budget before the other was counted,
 * letting the pair through when only one fits.
 */
export function createGate(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

// ── The upload runner ─────────────────────────────────────────────────────────

export type UploadOutcome =
  | { ok: true; path: string; url: string; preparedSize: number }
  | { ok: false; error: string; preparedSize: number | null }

export type UploadDeps = {
  /** Canvas image compression; returns the file unchanged when not compressible. */
  compress: (file: File) => Promise<File>
  /** Serialises prepare + size check across concurrently added files. */
  gate: <T>(fn: () => Promise<T>) => Promise<T>
  /** Caps in-flight uploads. */
  semaphore: Semaphore
  /** Current queue, read fresh — items may have been removed mid-upload. */
  currentItems: () => readonly PendingAttachment[]
  buildPath: (fileName: string) => string
  upload: (path: string, file: File) => Promise<{ error: unknown }>
  publicUrl: (path: string) => string
  /** Reports intermediate states so the UI can move preparing → uploading. */
  onStatus: (status: PendingAttachmentStatus, patch?: Partial<PendingAttachment>) => void
}

export type AttachmentUploadError = { error: unknown }

/**
 * Prepare, size-check, then upload one file.
 *
 * Expected failures (over budget, storage rejected the object) are returned as
 * `ok:false` so the item can show Retry; only a genuine programming error
 * throws, and the caller converts that into the same shape rather than losing
 * the item.
 */
export async function runAttachmentUpload(
  item: PendingAttachment,
  deps: UploadDeps,
): Promise<UploadOutcome> {
  const prepared = await deps.gate(async () => {
    const compressed = await deps.compress(item.file)
    // Exclude this item from its own budget check — it has no preparedSize yet,
    // but a retry after a *failed upload* does, and would double-count.
    const others = deps.currentItems().filter(a => a.id !== item.id)
    if (exceedsSizeLimit(others, compressed.size)) {
      return { ok: false as const, error: ATTACHMENT_SIZE_ERROR }
    }
    return { ok: true as const, file: compressed }
  })

  if (!prepared.ok) return { ok: false, error: prepared.error, preparedSize: null }

  const file = prepared.file
  deps.onStatus('uploading', { preparedSize: file.size, size: file.size })

  const done = await deps.semaphore.acquire()
  try {
    const path = deps.buildPath(file.name)
    const { error } = await deps.upload(path, file)
    if (error) return { ok: false, error: 'Upload failed', preparedSize: file.size }
    return { ok: true, path, url: deps.publicUrl(path), preparedSize: file.size }
  } finally {
    done()
  }
}

// ── The queue controller ──────────────────────────────────────────────────────

/** Structural match for PerfTracker, so this module stays import-free. */
export type QueueTimer = { mark: (name: string) => void; end: () => unknown }

export type QueueDeps = {
  taskId: string
  compress: (file: File) => Promise<File>
  upload: (path: string, file: File) => Promise<{ error: unknown }>
  publicUrl: (path: string) => string
  /** Delete a stored object. Best-effort — the queue never surfaces its failure. */
  deleteObject: (path: string) => Promise<void>
  /** Called after every state transition so the view can re-render. */
  onChange: (items: PendingAttachment[]) => void
  concurrency?: number
  buildPath?: (taskId: string, fileName: string) => string
  track?: () => QueueTimer
}

export type AttachmentQueue = {
  items: () => readonly PendingAttachment[]
  /** Queue accepted files and start uploading each immediately. */
  add: (files: readonly File[]) => { added: number; duplicateNames: string[] }
  /** Drop an item and delete its stored object when one exists. */
  remove: (id: string) => void
  /** Re-run a failed item's upload. No-op for any other state. */
  retry: (id: string) => void
  /** Resolve once nothing is in flight. Finished items are not re-uploaded. */
  settleAll: () => Promise<void>
  hasPending: () => boolean
  /** Forget everything after a successful submit — objects stay, they are now referenced. */
  clear: () => void
}

const NOOP_TIMER: QueueTimer = { mark: () => {}, end: () => undefined }

/**
 * Owns the pending-attachment list and its in-flight uploads.
 *
 * The queue — not React state — is the authority on what is attached: uploads
 * settle asynchronously and a removal can land mid-flight, so a handler reading
 * a render-time snapshot would act on a stale list. `onChange` publishes each
 * transition outward for rendering only.
 */
export function createAttachmentQueue(deps: QueueDeps): AttachmentQueue {
  let items: PendingAttachment[] = []
  const inFlight = new Map<string, Promise<UploadOutcome>>()
  const semaphore = createSemaphore(deps.concurrency ?? 3)
  const gate = createGate()
  const pathOf = deps.buildPath ?? buildAttachmentPath
  let seq = 0

  const publish = (next: PendingAttachment[]) => { items = next; deps.onChange(items) }
  const forget = (path: string) => { void deps.deleteObject(path).catch(() => {}) }

  const start = (item: PendingAttachment) => {
    const timer = deps.track ? deps.track() : NOOP_TIMER
    const promise = runAttachmentUpload(item, {
      compress:     deps.compress,
      gate,
      semaphore,
      currentItems: () => items,
      buildPath:    (fileName) => pathOf(deps.taskId, fileName),
      upload:       deps.upload,
      publicUrl:    deps.publicUrl,
      onStatus:     (status, patch) => {
        timer.mark(status)
        publish(patchAttachment(items, item.id, { status, ...patch }))
      },
    }).catch((err): UploadOutcome => {
      // A genuine throw must still leave a retryable item, never a silent gap.
      console.error('[attachment upload] unexpected error:', err)
      return { ok: false, error: 'Upload failed', preparedSize: null }
    })

    inFlight.set(item.id, promise)
    void promise.then(outcome => {
      timer.end()
      // Removed while its bytes were still moving: drop the object rather than
      // resurrect the row.
      if (!items.some(a => a.id === item.id)) {
        if (outcome.ok) forget(outcome.path)
        inFlight.delete(item.id)
        return
      }
      publish(patchAttachment(items, item.id, outcome.ok
        ? { status: 'uploaded', path: outcome.path, url: outcome.url, preparedSize: outcome.preparedSize, size: outcome.preparedSize, error: null }
        : { status: 'failed', error: outcome.error, preparedSize: outcome.preparedSize }))
    })
    return promise
  }

  return {
    items: () => items,

    add(files) {
      const { added, duplicateNames } = partitionIncoming(items, files)
      const fresh: PendingAttachment[] = added.map(file => ({
        id:           `att-${++seq}`,
        file,
        fileName:     file.name,
        size:         file.size,
        preparedSize: null,
        status:       'preparing',
        path:         null,
        url:          null,
        error:        null,
      }))
      if (fresh.length > 0) publish([...items, ...fresh])
      for (const item of fresh) start(item)
      return { added: fresh.length, duplicateNames }
    },

    remove(id) {
      const item = items.find(a => a.id === id)
      if (!item) return
      publish(removeAttachment(items, id))
      inFlight.delete(id)
      if (item.status === 'uploaded' && item.path) forget(item.path)
    },

    retry(id) {
      const item = items.find(a => a.id === id)
      if (!item || item.status !== 'failed') return
      const reset: PendingAttachment = { ...item, status: 'preparing', error: null, preparedSize: null }
      publish(patchAttachment(items, id, { status: 'preparing', error: null, preparedSize: null }))
      start(reset)
    },

    async settleAll() {
      // Loop because a retry started during the wait adds a new promise, and an
      // upload that finishes can leave nothing outstanding.
      while (true) {
        const pending = items.map(a => inFlight.get(a.id)).filter(Boolean) as Promise<UploadOutcome>[]
        if (pending.length === 0) return
        await Promise.all(pending)
        for (const a of items) {
          if (a.status === 'uploaded' || a.status === 'failed') inFlight.delete(a.id)
        }
        if (!items.some(a => a.status === 'preparing' || a.status === 'uploading')) return
      }
    },

    hasPending: () => hasPendingUploads(items),

    clear() {
      inFlight.clear()
      publish([])
    },
  }
}
