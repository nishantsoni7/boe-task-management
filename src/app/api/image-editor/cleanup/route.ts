// GET /api/image-editor/cleanup
//
// The nightly sweep: deletes every Image Editor result whose seven days have
// passed and which nobody marked Keep. Driven by Vercel Cron — see the `crons`
// entry in vercel.json.
//
// MAKES NO PROVIDER CALL AND SPENDS NOTHING with fal. FAL_KEY is not imported.
//
// WHY GET
// -------
// Vercel Cron invokes its target with GET and sends
// `Authorization: Bearer $CRON_SECRET`. This route exists to be called that
// way, so GET is the verb even though it mutates — a POST-only handler would
// simply never run.
//
// WHY THIS ROUTE IS NOT LOAD-BEARING FOR CORRECTNESS
// --------------------------------------------------
// Expiry is enforced on READ: /api/image-editor/results filters
// `kept OR expires_at > now()`, so an expired result stops being listed the
// moment it expires, whether or not this ever runs. What this route does is
// reclaim BYTES. If it is late, or fails, or is never scheduled, no employee
// sees an image they should not — the storage bill simply stops falling. That
// is the deliberate design: a scheduler is a thing that fails, so nothing about
// privacy was made to depend on one.
//
// AUTHORIZATION
// -------------
// A shared secret, compared in constant time. There is no user here — the
// caller is a scheduler — so the usual bearer-token path does not apply and
// this endpoint must not be reachable by anybody who has not been told the
// secret. With CRON_SECRET unset the route answers 503 and does NOTHING: an
// unconfigured deployment must not expose an unauthenticated endpoint that
// deletes rows.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { sweepExpired } from '@/lib/imageEditor/history'
import { CLEANUP_BATCH_LIMIT, HISTORY_BUCKET } from '@/lib/imageEditor/retention'
import { serviceClient } from '@/lib/imageEditor/historyServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A backlog is swept in batches of CLEANUP_BATCH_LIMIT, one row at a time. Sixty
// seconds is the ceiling; whatever is not reached today is still due tomorrow.
export const maxDuration = 60

/** Constant-time compare that does not leak the secret's length. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error('[image-editor/cleanup] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'Cleanup is not configured.' }, { status: 503 })
  }

  const provided = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const svc = serviceClient()

  // Due = past its window AND not kept. Exactly the inverse of the filter the
  // listing route applies, so nothing can be invisible-but-undeleted for long,
  // and nothing kept is ever selected here.
  const nowIso = new Date().toISOString()
  const { data, error } = await svc
    .from('image_editor_results')
    .select('id, user_id, storage_path')
    .eq('kept', false)
    .lte('expires_at', nowIso)
    // Oldest first: on a backlog the longest-expired go first, so the thing
    // that has outstayed its welcome most is the thing that leaves soonest.
    .order('expires_at', { ascending: true })
    .limit(CLEANUP_BATCH_LIMIT)

  if (error) {
    console.error('[image-editor/cleanup] read failed:', error.message)
    return NextResponse.json({ error: 'Cleanup could not run.' }, { status: 500 })
  }

  const rows = data ?? []
  if (rows.length === 0) {
    console.info('[image-editor/cleanup] nothing due')
    return NextResponse.json({ scanned: 0, deleted: 0, failed: 0 })
  }

  // Object first, then row, one at a time, and one failure never stops the
  // rest — all three rules live in sweepExpired so the sweep and the owner's
  // manual delete cannot drift apart. See the ordering note in history.ts.
  const report = await sweepExpired(
    {
      storage: svc.storage.from(HISTORY_BUCKET),
      deleteRow: async (rowId, ownerId) => {
        const { error: delErr } = await svc
          .from('image_editor_results')
          .delete()
          .eq('id', rowId)
          .eq('user_id', ownerId)
        return { error: delErr ? { message: delErr.message } : null }
      },
    },
    rows,
    (id, stage, reason) =>
      console.error('[image-editor/cleanup] left behind', id, 'at the', stage, 'stage:', reason),
  )

  console.info(
    '[image-editor/cleanup] scanned', report.scanned,
    'deleted', report.deleted,
    'failed', report.failed,
    report.scanned === CLEANUP_BATCH_LIMIT ? '(batch full — more remain for the next run)' : '',
  )

  return NextResponse.json(report)
}
