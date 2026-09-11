// Task creation: WHAT THE CLICK WAITS FOR, in one place.
//
// Shared by /tasks/create and /tasks/create-self — the two creation screens the
// app can actually reach (the header's Self Task / Delegate Task buttons). The
// screens keep every Supabase call, every message and every state setter; this
// module only decides the ORDER of their steps and which of them the person
// pressing Create has to wait for.
//
// MEASURED BEFORE (production, /tasks/create-self, no attachments, 2026-09-11):
//
//   similar-task read   236–679 ms   ← every open task of the assignee, fetched AFTER the click
//   task insert         212–319 ms
//   activity-log insert 212–270 ms
//   success banner      690–1373 ms after the click
//
// and /tasks/create waited on the assignment notification route as well.
//
// WHAT IS STILL AWAITED, AND WHY
//
//   1. The similar-task check — a business rule that can stop the creation, so it
//      must finish first. Its candidates are normally read BEFORE the click (when
//      the assignee is chosen), which is what removes the round trip.
//   2. Attachment preparation — only when there are files.
//   3. The task insert — the authoritative write.
//   4. The `created` activity row — the audit record stays part of "created".
//   5. Attachment uploads — only when there are files (unchanged slower path).
//
// WHAT IS NOT
//
//   The assignee notification. It starts once the activity row EXISTS — so the
//   server links the notification to it instead of racing it — and it reports its
//   own outcome to the screen whenever it settles.

export type SimilarTitleCandidate = { id: string; title: string }

/**
 * The similar-task rule, unchanged: three or more of the title's words longer
 * than three characters appear in an existing open task's title.
 */
export function findSimilarTitle(
  title: string,
  existing: readonly SimilarTitleCandidate[],
): SimilarTitleCandidate | null {
  const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 3)
  return existing.find(t => {
    const matches = titleWords.filter(w => t.title.toLowerCase().includes(w))
    return matches.length >= 3
  }) ?? null
}

/** How long a candidate list read before the click may stand in for a read at the click. */
export const DUPLICATE_CANDIDATES_MAX_AGE_MS = 60_000

/**
 * The similar-task candidates for an assignee, read ahead of the click.
 *
 * `prime` starts the read (when the assignee is chosen); `candidates` returns it
 * at submit — the same promise if it is younger than the max age, a fresh read
 * otherwise. A FAILED read is never kept: it resolves to no candidates for that
 * submit, exactly as the inline read did, and the next submit reads again.
 */
export function createDuplicateCandidateCache(
  load: (assigneeId: string) => PromiseLike<SimilarTitleCandidate[] | null>,
  options: { maxAgeMs?: number; now?: () => number } = {},
) {
  const maxAgeMs = options.maxAgeMs ?? DUPLICATE_CANDIDATES_MAX_AGE_MS
  const now = options.now ?? Date.now
  const entries = new Map<string, { promise: Promise<SimilarTitleCandidate[] | null>; at: number }>()

  const start = (assigneeId: string) => {
    const entry = {
      promise: Promise.resolve(load(assigneeId)).catch(() => null),
      at: now(),
    }
    entries.set(assigneeId, entry)
    void entry.promise.then(rows => {
      if (rows === null && entries.get(assigneeId) === entry) entries.delete(assigneeId)
    })
    return entry
  }

  const fresh = (assigneeId: string) => {
    const entry = entries.get(assigneeId)
    return entry && now() - entry.at <= maxAgeMs ? entry : null
  }

  return {
    prime(assigneeId: string) {
      if (assigneeId && !fresh(assigneeId)) start(assigneeId)
    },
    async candidates(assigneeId: string): Promise<SimilarTitleCandidate[]> {
      const entry = fresh(assigneeId) ?? start(assigneeId)
      return (await entry.promise) ?? []
    },
    /** A task just created for this assignee is a candidate for the next check. */
    remember(assigneeId: string, candidate: SimilarTitleCandidate) {
      const entry = entries.get(assigneeId)
      if (entry) entry.promise = entry.promise.then(rows => (rows ? [...rows, candidate] : rows))
    },
  }
}

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.'

export type TaskCreateOutcome<T> =
  /** A creation is already in flight — the second click of a double click. Nothing started. */
  | { status: 'busy' }
  /** The form is incomplete. Nothing started. */
  | { status: 'invalid' }
  /** The creator declined the similar-task warning. Nothing written. */
  | { status: 'cancelled' }
  /** The files could not be prepared. Nothing written. */
  | { status: 'attachments_invalid' }
  /** The task was NOT created. */
  | { status: 'failed'; message: string }
  | { status: 'created'; task: T }

export type TaskCreateSteps<T extends { id: string }, A> = {
  /** Read and set synchronously, so two clicks in one tick create one task. */
  guard: { current: boolean }
  validate: () => boolean
  /** Runs synchronously on the click that starts a creation — the saving state. */
  onStart: () => void
  findSimilar: () => Promise<SimilarTitleCandidate | null>
  confirmSimilar: (similar: SimilarTitleCandidate) => boolean
  /** Null when there are no files: no attachment machinery is touched at all. */
  prepareAttachments: null | (() => Promise<A[] | null>)
  insertTask: () => Promise<{ task: T } | { error: string }>
  insertActivity: (task: T) => Promise<void>
  /** Started after the activity row exists, and never awaited. */
  notifyAssignee?: (task: T) => void
  uploadAttachments?: (task: T, files: A[]) => Promise<void>
  mark?: (phase: string) => void
}

export async function runTaskCreation<T extends { id: string }, A>(
  steps: TaskCreateSteps<T, A>,
): Promise<TaskCreateOutcome<T>> {
  if (steps.guard.current) return { status: 'busy' }
  if (!steps.validate()) return { status: 'invalid' }
  steps.guard.current = true
  steps.onStart()
  try {
    const similar = await steps.findSimilar()
    steps.mark?.('similar-check')
    if (similar && !steps.confirmSimilar(similar)) return { status: 'cancelled' }

    let files: A[] = []
    if (steps.prepareAttachments) {
      const ready = await steps.prepareAttachments()
      if (!ready) return { status: 'attachments_invalid' }
      files = ready
      steps.mark?.('prepare-attachments')
    }

    const inserted = await steps.insertTask()
    if ('error' in inserted) return { status: 'failed', message: inserted.error }
    const { task } = inserted
    steps.mark?.('insert-task')

    await steps.insertActivity(task)
    steps.mark?.('insert-activity')

    // Not awaited: the creator is not held on the form by the notification.
    steps.notifyAssignee?.(task)

    if (files.length && steps.uploadAttachments) {
      await steps.uploadAttachments(task, files)
      steps.mark?.('upload-attachments')
    }
    return { status: 'created', task }
  } finally {
    steps.guard.current = false
  }
}
