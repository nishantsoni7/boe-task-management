// Sample Tracking notification deletes — snapshot / optimistic write / rollback.
//
// This is the Sample Tracking counterpart to src/lib/notificationMutations.ts,
// and deliberately follows the same five-step contract:
//
//   1. snapshot the current list
//   2. write the optimistic change (rows vanish immediately)
//   3. issue the request
//   4. on ANY failure — thrown network error or non-2xx — restore the snapshot
//      and report a user-safe message
//   5. on success — leave the optimistic state in place
//
// Why it is a separate module rather than a `category: 'sample'` added to the
// existing one: Sample Tracking notifications live in their own
// `sample_notifications` table with their own shape (`event`, no `type` enum,
// no `task_id`), and every Task/Finance/Order helper is bound to the shared
// `notifications` table via getNotificationCategoryFilter. Threading a fourth
// category through those helpers would rewrite live Task Management code to
// query a table it can never reach. Only the genuinely table-agnostic pieces
// are reused: `readApiError` (below) and `createPendingGuard` (used by the page).
//
// Framework-free on purpose. The page owns React state and hands this module a
// getState/setState pair, so the exact sequences below are what the browser
// runs AND what the tests drive — see sampleNotificationDeletes.test.ts.

import { readApiError } from '@/lib/notificationCache'

export type SampleNotif = {
  id: string
  event: string
  title: string
  body: string | null
  is_read: boolean
  created_at: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The slice of page state these mutations read and write. */
export type SampleNotifState = {
  notifs: SampleNotif[]
  selected: ReadonlySet<string>
  /** Last failure, rendered in the inline banner. `null` when clear. */
  error: string | null
}

export type SampleDeleteDeps = {
  /** Latest state at the moment of the call. */
  getState: () => SampleNotifState
  setState: (next: SampleNotifState) => void
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchLike
  /** Called after a single delete settles, so the caller can release its lock. */
  releasePending?: (id: string) => void
}

const doFetch = (deps: SampleDeleteDeps): FetchLike =>
  deps.fetchFn ?? ((input, init) => fetch(input, init))

const subtract = (set: ReadonlySet<string>, ids: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set(set)
  for (const id of ids) next.delete(id)
  return next
}

/** Step 2 — rows disappear now; selection drops them; any stale error clears. */
function removeOptimistically(state: SampleNotifState, ids: ReadonlySet<string>): SampleNotifState {
  return {
    notifs: state.notifs.filter(n => !ids.has(n.id)),
    selected: subtract(state.selected, ids),
    error: null,
  }
}

/**
 * Step 4 — put the rows back and say why.
 *
 * The LIST is restored from the snapshot, but the SELECTION is taken from the
 * current state, not the snapshot. That matches Task Management exactly: it
 * clears the selection the moment a bulk delete is initiated and never
 * re-selects rows a failed request rolled back, so the user is never left
 * holding a selection they did not make.
 */
function rollback(
  current: SampleNotifState,
  snapshot: SampleNotifState,
  message: string,
): SampleNotifState {
  return { notifs: snapshot.notifs, selected: current.selected, error: message }
}

const messageFor = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback

// ── Delete one ─────────────────────────────────────────────────────────────

export async function deleteSampleNotification(deps: SampleDeleteDeps, id: string): Promise<void> {
  const snapshot = deps.getState()
  deps.setState(removeOptimistically(snapshot, new Set([id])))

  try {
    const res = await doFetch(deps)(`/api/samples/notifications/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await readApiError(res, 'Could not delete this notification'))
    // A `deleted: false` body is a legitimate idempotent outcome — the row was
    // already gone (a retry, or a delete from another tab). The caller's intent
    // still holds, so the optimistic removal stands rather than resurrecting a
    // row that does not exist.
    await res.json().catch(() => ({}))
  } catch (err) {
    deps.setState(rollback(deps.getState(), snapshot, messageFor(err, 'Could not delete this notification.')))
  } finally {
    deps.releasePending?.(id)
  }
}

// ── Delete selected ────────────────────────────────────────────────────────

export async function deleteSelectedSampleNotifications(
  deps: SampleDeleteDeps,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const snapshot = deps.getState()
  deps.setState(removeOptimistically(snapshot, new Set(ids)))

  try {
    const res = await doFetch(deps)('/api/samples/notifications/delete-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!res.ok) throw new Error(await readApiError(res, 'Could not delete the selected notifications'))
    await res.json().catch(() => ({}))
  } catch (err) {
    deps.setState(rollback(deps.getState(), snapshot, messageFor(err, 'Could not delete the selected notifications.')))
  }
}

// ── Delete all (this user's sample notifications only) ─────────────────────

export async function deleteAllSampleNotifications(deps: SampleDeleteDeps): Promise<void> {
  const snapshot = deps.getState()
  deps.setState({ notifs: [], selected: new Set(), error: null })

  try {
    const res = await doFetch(deps)('/api/samples/notifications', { method: 'DELETE' })
    if (!res.ok) throw new Error(await readApiError(res, 'Could not delete all notifications'))
    await res.json().catch(() => ({}))
  } catch (err) {
    deps.setState(rollback(deps.getState(), snapshot, messageFor(err, 'Could not delete all notifications.')))
  }
}
