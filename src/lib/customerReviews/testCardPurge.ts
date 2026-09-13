// PERMANENTLY DELETING AN INTERNAL TEST RECORD.
//
// An administrator's action, and a narrow one. The authority and the
// eligibility rule live in the database — migration 20261209000000 — and are
// checked twice there under the card's row lock. What lives here is:
//
//   * the ORDER OF WORK across two systems no transaction spans, so every
//     failure and every retry can be driven in testCardPurge.test.ts without a
//     live Supabase project;
//   * the browser's MIRROR of the eligibility rule, which decides only whether
//     a control is drawn;
//   * the sentences a caller may be shown.
//
// THE ORDER, and why it cannot be rearranged:
//
//   START   begin_customer_review_test_card_purge() checks, then tombstones the
//           card. The tombstone freezes it, so nothing can approve, book or
//           attach to it while its files go.
//   FILES   every object under `<card id>/` is removed through the Storage API.
//           Listing the folder, not just the metadata rows, is what catches an
//           object whose row was never written.
//   FINISH  finish_customer_review_test_card_purge() refuses while any object
//           under the prefix remains, then deletes the card. Its screenshot and
//           event rows cascade.
//
// A failure between the steps leaves a frozen card that still names its files,
// and running the whole thing again converges: START is repeatable on a purge
// already started, removing a missing object is not an error, and FINISH on a
// card already gone reports success.
//
// NOTHING HERE IMPORTS A PRIVILEGED CLIENT. The service is built from two
// functions the caller hands in, so this file is safe to import from a screen.

import { TEST_SCREENSHOT_BUCKET } from './photos'
import { REVIEW_IMAGE_KIND } from './reviewImages'
import type { TestCard, TestCardPhoto } from './types'

/** The one bucket a purge removes files from. Never the project images, never custom proofs. */
export const TEST_CARD_PURGE_BUCKET = TEST_SCREENSHOT_BUCKET

// ── Who is offered it ─────────────────────────────────────────────────────────

/**
 * The event types an internal draft may carry. Mirrors the allow-list in
 * customer_review_test_card_purge_blocker().
 */
export const PURGE_INTERNAL_EVENT_TYPES: readonly string[] = [
  'generated',
  'revised',
  'draft_edited',
  'image_removed',
  'image_group_set',
]

export type PurgeBlocker = 'deleted' | 'released' | 'history' | 'evidence'

/**
 * Why this card may NOT be permanently deleted, or null when it may.
 *
 * The browser half of customer_review_test_card_purge_blocker(), clause for
 * clause, minus the BOE Credits check the browser cannot read. A card never
 * approved cannot have a reward, and the database re-checks the ledger anyway.
 *
 * It decides WHETHER TO DRAW A CONTROL. The database decides whether anything
 * happens.
 */
export function testCardPurgeBlocker(
  card: Pick<TestCard,
    | 'status' | 'deleted_at' | 'approved_at' | 'assigned_to' | 'booked_by'
    | 'whatsapp_opened_at' | 'whatsapp_opened_count' | 'sent_confirmed_at'
    | 'submitted_at' | 'verified_at'>,
  // A plain string, not TestCardEventType: the database has event types the
  // browser's union does not name, and an unknown one must refuse, not fail to
  // compile.
  events: readonly { event_type: string }[],
  attachments: readonly Pick<TestCardPhoto, 'kind'>[],
): PurgeBlocker | null {
  if (card.deleted_at) return 'deleted'
  if (
    card.status !== 'pending_approval'
    || card.approved_at
    || card.assigned_to
    || card.booked_by
    || card.whatsapp_opened_at
    || card.whatsapp_opened_count !== 0
    || card.sent_confirmed_at
    || card.submitted_at
    || card.verified_at
  ) return 'released'
  if (events.some(e => !PURGE_INTERNAL_EVENT_TYPES.includes(e.event_type))) return 'history'
  if (attachments.some(a => a.kind !== REVIEW_IMAGE_KIND)) return 'evidence'
  return null
}

// ── The purge page's record ───────────────────────────────────────────────────

/**
 * One card as customer_review_test_card_purge_record() returns it: to an
 * active admin only, only while the card may still be purged. It is what the
 * purge page shows to an admin without `verify`, and what an interrupted purge
 * is continued from after a reload.
 */
export type PurgeRecord = {
  id: string
  cardRef: string
  testTitle: string
  testBody: string
  status: string
  reviewType: string
  createdAt: string | null
  /** The purge has started (the card carries its purge tombstone) and not finished. */
  purgeInProgress: boolean
  attachments: { kind: string; fileName: string }[]
  events: { eventType: string; detail: string | null; createdAt: string | null }[]
}

/** The database's answer, or null for anything that is not a record. */
export function purgeRecordFrom(raw: unknown): PurgeRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.card_ref !== 'string' || typeof r.test_title !== 'string') return null
  const text = (v: unknown) => (typeof v === 'string' ? v : null)
  const rows = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []
  return {
    id: r.id,
    cardRef: r.card_ref,
    testTitle: r.test_title,
    testBody: text(r.test_body) ?? '',
    status: text(r.status) ?? '',
    reviewType: text(r.review_type) ?? 'text',
    createdAt: text(r.created_at),
    purgeInProgress: r.purge_in_progress === true,
    attachments: rows(r.attachments).map(a => ({ kind: text(a.kind) ?? '', fileName: text(a.file_name) ?? '' })),
    events: rows(r.events).map(e => ({ eventType: text(e.event_type) ?? '', detail: text(e.detail), createdAt: text(e.created_at) })),
  }
}

// ── What a caller may be told ─────────────────────────────────────────────────

/** Every sentence the route returns. An allow-list, never a formatter. */
export const PURGE_MESSAGES = {
  unauthenticated: 'Sign in to continue.',
  forbidden:       'Only an active administrator can permanently delete a test record.',
  not_found:       'That test record is not available.',
  reward_attached: 'This review has BOE Credits attached. The reward must be handled separately, so the record cannot be permanently deleted.',
  not_eligible:    'This review is no longer an internal test record, so it cannot be permanently deleted.',
  bad_request:     'That request could not be processed.',
  unavailable:     'Permanent deletion is not configured on this deployment.',
  storage_failed:  'Not every stored file could be removed, so the record was not deleted. Try again.',
  failed:          'The test record could not be permanently deleted. Try again.',
} as const

export type PurgeRefusal = 'forbidden' | 'not_found' | 'reward_attached' | 'not_eligible'

const REFUSAL_CODES: Record<string, PurgeRefusal> = {
  CUSTOMER_REVIEW_TEST_UNAUTHORIZED:          'forbidden',
  CUSTOMER_REVIEW_TEST_NOT_FOUND:             'not_found',
  CUSTOMER_REVIEW_TEST_PURGE_REWARD_ATTACHED: 'reward_attached',
  CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE:    'not_eligible',
}

/**
 * A database refusal, read from its marker. `detail` is the sentence the
 * migration wrote for a NOT_ELIGIBLE refusal — which of the five reasons it was
 * — and is null for everything else, where the fixed message says it all.
 */
export function purgeRefusalFrom(
  message: string | null | undefined,
): { reason: PurgeRefusal; detail: string | null } | null {
  const match = /^([A-Z_]+):\s*([\s\S]*)$/.exec((message ?? '').trim())
  if (!match) return null
  const reason = REFUSAL_CODES[match[1]]
  if (!reason) return null
  const sentence = match[2].trim()
  return { reason, detail: reason === 'not_eligible' && sentence ? `${sentence}.` : null }
}

// ── The service, and the order of work ────────────────────────────────────────

export type PurgeStartResult =
  | { outcome: 'started'; storagePaths: string[] }
  | { outcome: 'refused'; reason: PurgeRefusal; detail: string | null }
  | { outcome: 'error' }

export type PurgeFinishResult =
  | { outcome: 'purged' }
  | { outcome: 'already_gone' }
  | { outcome: 'files_remain' }
  | { outcome: 'refused'; reason: PurgeRefusal; detail: string | null }
  | { outcome: 'error' }

export type PurgeService = {
  start(cardId: string, actorId: string): Promise<PurgeStartResult>
  /** Every object under `<card id>/`, at any depth. */
  listObjects(cardId: string): Promise<{ ok: true; paths: string[] } | { ok: false }>
  /** Removing an object that is already gone is a success. */
  removeObjects(paths: string[]): Promise<{ ok: boolean }>
  finish(cardId: string, actorId: string): Promise<PurgeFinishResult>
}

export type PurgeOutcome =
  | { status: 'purged' }
  | { status: 'refused'; reason: PurgeRefusal; detail: string | null }
  | { status: 'failed'; reason: 'storage' | 'files_remain' | 'unknown' }

/** The paths that belong to this card, once each. Anything else is dropped. */
export function objectPathsForCard(cardId: string, paths: readonly string[]): string[] {
  const prefix = `${cardId}/`
  return [...new Set(paths.filter(p => typeof p === 'string' && p.startsWith(prefix) && p.length > prefix.length))].sort()
}

/**
 * Run a purge, or resume one.
 *
 * `actorId` is the identity the route established from the session, never
 * anything the browser sent; the database re-checks it on both calls.
 */
export async function runTestCardPurge(
  service: PurgeService,
  actorId: string,
  cardId: string,
): Promise<PurgeOutcome> {
  const started = await service.start(cardId, actorId)
  if (started.outcome === 'refused') return { status: 'refused', reason: started.reason, detail: started.detail }
  if (started.outcome === 'error') return { status: 'failed', reason: 'unknown' }

  // THE FOLDER, NOT ONLY THE ROWS. A file whose metadata insert failed has no
  // row, and FINISH would refuse forever if it were left behind.
  const listed = await service.listObjects(cardId)
  if (!listed.ok) return { status: 'failed', reason: 'storage' }

  const paths = objectPathsForCard(cardId, [...started.storagePaths, ...listed.paths])
  if (paths.length > 0) {
    const removed = await service.removeObjects(paths)
    if (!removed.ok) return { status: 'failed', reason: 'storage' }
  }

  const finished = await service.finish(cardId, actorId)
  switch (finished.outcome) {
    case 'purged':
    case 'already_gone':
      return { status: 'purged' }
    case 'files_remain':
      return { status: 'failed', reason: 'files_remain' }
    case 'refused':
      return { status: 'refused', reason: finished.reason, detail: finished.detail }
    case 'error':
      return { status: 'failed', reason: 'unknown' }
  }
}

// ── The service, built from the two things it needs ───────────────────────────

type RpcResult = { data: unknown; error: { message?: string } | null }

export type PurgeServiceDeps = {
  /** A service-role RPC call. */
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>
  /** The service-role Storage API for TEST_CARD_PURGE_BUCKET. */
  bucket: {
    list(
      path: string,
      options?: { limit?: number; offset?: number },
    ): PromiseLike<{ data: { name: string; id: string | null }[] | null; error: unknown }>
    remove(paths: string[]): PromiseLike<{ data: unknown; error: unknown }>
  }
}

const LIST_PAGE = 1000
/** `<card>/<kind>/<file>` is two levels; four is room without being unbounded. */
const LIST_DEPTH = 4
const REMOVE_CHUNK = 100

export function testCardPurgeService(deps: PurgeServiceDeps): PurgeService {
  return {
    async start(cardId, actorId) {
      const { data, error } = await deps.rpc('begin_customer_review_test_card_purge', {
        p_card_id: cardId,
        p_actor_id: actorId,
      })
      if (error) {
        const refusal = purgeRefusalFrom(error.message)
        return refusal ? { outcome: 'refused', ...refusal } : { outcome: 'error' }
      }
      const raw = (data as { storage_paths?: unknown } | null)?.storage_paths
      if (!Array.isArray(raw)) return { outcome: 'error' }
      return { outcome: 'started', storagePaths: raw.filter((p): p is string => typeof p === 'string') }
    },

    async listObjects(cardId) {
      const paths: string[] = []
      const walk = async (folder: string, depth: number): Promise<boolean> => {
        for (let offset = 0; ; offset += LIST_PAGE) {
          const { data, error } = await deps.bucket.list(folder, { limit: LIST_PAGE, offset })
          if (error || !data) return false
          for (const entry of data) {
            const path = `${folder}/${entry.name}`
            // The Storage API lists a folder as an entry with no id.
            if (entry.id === null) {
              if (depth >= LIST_DEPTH) return false
              if (!(await walk(path, depth + 1))) return false
            } else {
              paths.push(path)
            }
          }
          if (data.length < LIST_PAGE) return true
        }
      }
      return (await walk(cardId, 1)) ? { ok: true, paths } : { ok: false }
    },

    async removeObjects(paths) {
      for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
        const { error } = await deps.bucket.remove(paths.slice(i, i + REMOVE_CHUNK))
        if (error) return { ok: false }
      }
      return { ok: true }
    },

    async finish(cardId, actorId) {
      const { data, error } = await deps.rpc('finish_customer_review_test_card_purge', {
        p_card_id: cardId,
        p_actor_id: actorId,
      })
      if (error) {
        if ((error.message ?? '').startsWith('CUSTOMER_REVIEW_TEST_PURGE_FILES_REMAIN')) return { outcome: 'files_remain' }
        const refusal = purgeRefusalFrom(error.message)
        return refusal ? { outcome: 'refused', ...refusal } : { outcome: 'error' }
      }
      const result = data as { purged?: unknown; already_gone?: unknown } | null
      if (result?.purged === true) return { outcome: 'purged' }
      if (result?.already_gone === true) return { outcome: 'already_gone' }
      return { outcome: 'error' }
    },
  }
}
