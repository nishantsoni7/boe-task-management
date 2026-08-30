// Reading, writing and deleting a stored result.
//
// SERVER-SIDE. Every function here is handed the storage and table clients it
// needs rather than building its own, which is what lets the tests beside this
// file exercise the ordering and the partial-failure behaviour without a
// Supabase, a bucket or a network.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// ----------------------------------------
// A deletion removes THE OBJECT FIRST, THEN THE ROW. Never the other way
// round.
//
// The two orders fail very differently:
//
//   object → row   the object goes, the row delete fails, the row survives. It
//                  is still due, so the next sweep picks it up and tries again.
//                  Deleting an object that is already gone is not an error, so
//                  the retry is harmless. Nothing is lost and nothing leaks.
//
//   row → object   the row goes, the object delete fails, and the only record
//                  of where that object lives has just been destroyed. The
//                  bytes remain in a private bucket for ever, paid for,
//                  unreachable and invisible to every sweep that follows.
//
// The second is unrecoverable without a bucket-wide reconciliation nobody is
// going to write. So the order is not a preference — it is the difference
// between a retry and a permanent orphan.

import type { VerificationStatus } from './verification'
import { HISTORY_BUCKET, historyObjectPath } from './retention'

/** A stored result as the API hands it to the browser. Deliberately carries no
 *  storage path: the page gets a signed URL and never constructs one. */
export type HistoryResult = {
  id: string
  sourceFileName: string
  verification: VerificationStatus
  kept: boolean
  createdAt: string
  expiresAt: string
  /** Short-lived signed URL for the stored PNG. Null when signing failed, in
   *  which case the card shows the row without a picture rather than a broken
   *  image. */
  url: string | null
}

/** The row shape read from `image_editor_results`. */
export type HistoryRow = {
  id: string
  user_id: string
  storage_path: string
  source_file_name: string
  verification: VerificationStatus
  kept: boolean
  created_at: string
  expires_at: string
}

/** The columns every read asks for. `storage_path` is included because the
 *  server needs it to sign and to delete; it is stripped before the response. */
export const HISTORY_COLUMNS =
  'id, user_id, storage_path, source_file_name, verification, kept, created_at, expires_at'

/** Row → wire, with the storage path removed. */
export function toHistoryResult(row: HistoryRow, url: string | null): HistoryResult {
  return {
    id: row.id,
    sourceFileName: row.source_file_name,
    verification: row.verification,
    kept: row.kept,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    url,
  }
}

// ─── The minimal client surfaces ──────────────────────────────────────────────
//
// Structural types, not the Supabase ones. They name exactly the three calls
// this file makes, so a test supplies three functions instead of a database.

export type StorageLike = {
  upload(
    path: string,
    body: Buffer | Uint8Array,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ error: { message: string } | null }>
  remove(paths: string[]): Promise<{ error: { message: string } | null }>
}

export type HistoryDeps = {
  storage: StorageLike
  /** Deletes one row by id, scoped to its owner. Returns an error or null. */
  deleteRow(id: string, userId: string): Promise<{ error: { message: string } | null }>
}

// ─── Saving ───────────────────────────────────────────────────────────────────

export type SaveOutcome =
  | { ok: true; id: string }
  /** Why it failed, for the log. The employee is told only that history is
   *  unavailable — a storage message is not something to put on a screen. */
  | { ok: false; reason: string }

export type SaveDeps = {
  storage: StorageLike
  insertRow(row: {
    id: string
    user_id: string
    storage_path: string
    source_file_name: string
    verification: VerificationStatus
  }): Promise<{ error: { message: string } | null }>
  /** Injected so a test does not need a real uuid source. */
  newId(): string
}

/**
 * Store one generated master.
 *
 * BEST EFFORT, ALWAYS. The caller has already paid for two provider requests
 * and holds a finished image; a storage hiccup must never turn that into a
 * failed generation. Every path here returns an outcome and none of them
 * throws, so the studio route can report `historySaved: false` and still hand
 * over the picture.
 *
 * Object first, then the row — the mirror of the deletion order, for the same
 * reason. A row inserted before its object would, if the upload then failed,
 * point at nothing: the history would show a result that cannot be opened. An
 * object with no row is merely an orphan, and the sweep below reclaims it.
 *
 * NOTE the orphan window is real but bounded: an upload that succeeds and an
 * insert that fails leaves bytes nothing references. That is the lesser of the
 * two evils and is logged as such.
 */
export async function saveResult(
  deps: SaveDeps,
  input: {
    userId: string
    master: Buffer
    sourceFileName: string
    verification: VerificationStatus
  },
): Promise<SaveOutcome> {
  const id = deps.newId()
  const path = historyObjectPath(input.userId, id)

  try {
    const uploaded = await deps.storage.upload(path, input.master, {
      contentType: 'image/png',
      upsert: false,
    })
    if (uploaded.error) return { ok: false, reason: `upload: ${uploaded.error.message}` }

    const inserted = await deps.insertRow({
      id,
      user_id: input.userId,
      storage_path: path,
      source_file_name: input.sourceFileName,
      verification: input.verification,
    })
    if (inserted.error) {
      // The row did not land, so nothing will ever reference this object.
      // Removing it here keeps the orphan window to this function rather than
      // leaving it for a reconciliation nobody has written. A failure to clean
      // up is itself tolerated — it must not mask the original error.
      await deps.storage.remove([path]).catch(() => undefined)
      return { ok: false, reason: `insert: ${inserted.error.message}` }
    }

    return { ok: true, id }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown' }
  }
}

// ─── Deleting ─────────────────────────────────────────────────────────────────

export type DeleteOutcome =
  | { ok: true }
  | { ok: false; stage: 'object' | 'row'; reason: string }

/**
 * Delete one result: object first, then row.
 *
 * Used by BOTH the owner's manual delete and the nightly sweep, so the two
 * cannot drift into different orders — which is exactly how an orphan would
 * eventually appear.
 *
 * A failure at the object stage stops before touching the row, deliberately.
 * The row is the only record of where the object is; destroying it after a
 * failed object delete is the unrecoverable case described at the top of this
 * file. Leaving both in place means the next attempt can still succeed.
 */
export async function deleteResult(
  deps: HistoryDeps,
  row: { id: string; user_id: string; storage_path: string },
): Promise<DeleteOutcome> {
  try {
    const removed = await deps.storage.remove([row.storage_path])
    if (removed.error) return { ok: false, stage: 'object', reason: removed.error.message }
  } catch (e) {
    return {
      ok: false,
      stage: 'object',
      reason: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown',
    }
  }

  try {
    const deleted = await deps.deleteRow(row.id, row.user_id)
    if (deleted.error) return { ok: false, stage: 'row', reason: deleted.error.message }
  } catch (e) {
    return {
      ok: false,
      stage: 'row',
      reason: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown',
    }
  }

  return { ok: true }
}

export type SweepReport = {
  /** Rows that were due. */
  scanned: number
  /** Rows whose object and row are both gone. */
  deleted: number
  /** Rows left behind for the next pass. */
  failed: number
}

/**
 * Delete every row handed in, one at a time, and report honestly.
 *
 * SEQUENTIAL on purpose. A parallel sweep over a backlog would open hundreds of
 * simultaneous storage calls on a serverless function with a fixed time budget,
 * and the failure mode — a half-finished burst nobody can attribute — is much
 * worse to diagnose than a slower pass that stops cleanly.
 *
 * ONE FAILURE NEVER STOPS THE REST. A single unreadable object must not hold
 * up every other expired image behind it; the loop records it and moves on, and
 * a row that fails stays due, so tomorrow's pass tries again. That is why this
 * returns counts rather than throwing.
 */
export async function sweepExpired(
  deps: HistoryDeps,
  rows: readonly { id: string; user_id: string; storage_path: string }[],
  onFailure?: (id: string, stage: 'object' | 'row', reason: string) => void,
): Promise<SweepReport> {
  let deleted = 0
  let failed = 0

  for (const row of rows) {
    const outcome = await deleteResult(deps, row)
    if (outcome.ok) {
      deleted += 1
    } else {
      failed += 1
      onFailure?.(row.id, outcome.stage, outcome.reason)
    }
  }

  return { scanned: rows.length, deleted, failed }
}

/** The bucket, re-exported so a route imports one name rather than two. */
export { HISTORY_BUCKET }
