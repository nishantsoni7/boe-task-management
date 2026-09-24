// ── Edit PI, on the server (20270103000000) ──────────────────────────────────
//
// Reads the PI in force with the service role, exactly as the database holds
// it, so the proposal is priced against the real figures and not against
// whatever a browser last saw. Server-only: imported by the pi-edits routes.

import type { AdminSupabaseClient } from '@/lib/supabase/admin'
import {
  PI_EDIT_IMAGE_COLUMNS,
  PI_EDIT_ITEM_COLUMNS,
  PI_EDIT_SUBMISSION_COLUMNS,
  type PiContent,
  type PiContentImage,
  type PiContentItem,
} from './piEdit'

export type LoadedPi =
  | { ok: true; content: PiContent; row: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string }

export async function loadPiContent(service: AdminSupabaseClient, submissionId: string): Promise<LoadedPi> {
  const [sub, items, images] = await Promise.all([
    service.from('order_submissions').select(PI_EDIT_SUBMISSION_COLUMNS).eq('id', submissionId).maybeSingle(),
    service.from('order_submission_items').select(PI_EDIT_ITEM_COLUMNS).eq('submission_id', submissionId),
    service.from('order_submission_item_images').select(PI_EDIT_IMAGE_COLUMNS).eq('submission_id', submissionId),
  ])
  if (sub.error || items.error || images.error) {
    return { ok: false, status: 500, code: 'LOOKUP_FAILED', message: 'This PI could not be read. Please try again.' }
  }
  if (!sub.data) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'This PI no longer exists.' }
  const row = sub.data as unknown as Record<string, unknown>
  return {
    ok: true,
    row,
    content: {
      submission: row,
      items: (items.data ?? []) as unknown as PiContentItem[],
      images: (images.data ?? []) as unknown as PiContentImage[],
    },
  }
}

/** A database refusal, in the words a person reads. Never the raw message. */
export function describePiEditFailure(error: { message?: string; code?: string } | null): { status: number; code: string; message: string } {
  const m = error?.message ?? ''
  const rules: [RegExp, number, string, string][] = [
    [/ORDER_PI_REVISION_PENDING/, 409, 'ORDER_PI_REVISION_PENDING',
      'A revised PI is already waiting for a decision on this Order. It must be approved or rejected before another is proposed.'],
    [/ORDER_PI_REVISION_REASON_REQUIRED/, 400, 'REASON_REQUIRED', 'Say why the PI is being revised.'],
    [/ORDER_PI_REVISION_REASON_TOO_LONG/, 400, 'REASON_TOO_LONG', 'The reason may be at most 500 characters.'],
    [/ORDER_PI_REVISION_NOT_OWNER|permission/i, 403, 'FORBIDDEN', 'Only the person who owns this PI, or an administrator, may revise it.'],
    [/ORDER_PI_REVISION_ORDER_CLOSED/, 409, 'ORDER_CLOSED', 'This Order is cancelled and cannot take a revised PI.'],
    [/ORDER_PI_EDIT_STALE/, 409, 'STALE', 'The PI changed while this edit was being made. Reload and edit again.'],
    [/ORDER_PI_REVISION_AWAITING_OPERATIONS/, 409, 'AWAITING_OPERATIONS',
      'A revised PI is awaiting Operations acceptance; the PI cannot be edited until it is accepted or rejected.'],
    [/ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION/, 409, 'REQUIRES_REVISION',
      'This PI is approved and in force. Propose a new version instead.'],
    [/ORDER_SUBMISSION_REASON_REQUIRED/, 400, 'REASON_REQUIRED', 'Editing a submitted PI needs a reason.'],
    [/ORDER_SUBMISSION_PROCESSING_BUSY|55P03/, 409, 'PROCESSING_BUSY', 'This PI is already being processed. Please try again shortly.'],
    [/ORDER_SUBMISSION_DELETION_CLAIMED/, 409, 'DELETION_CLAIMED', 'This PI is reserved for deletion.'],
  ]
  for (const [re, status, code, message] of rules) if (re.test(m)) return { status, code, message }
  return { status: 500, code: 'EDIT_FAILED', message: 'The PI could not be saved just now. Nothing was changed. Please try again.' }
}
