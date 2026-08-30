// PATCH  /api/image-editor/results/[id]   Keep / Unkeep
// DELETE /api/image-editor/results/[id]   the owner removes their own result
//
// MAKES NO PROVIDER CALL AND SPENDS NOTHING. FAL_KEY is not imported here.
//
// OWNERSHIP
// ---------
// Both handlers act with the service role, which bypasses row-level security,
// so every statement carries `.eq('user_id', userId)` and that filter is the
// authorization. A result belonging to somebody else answers 404 rather than
// 403: a 403 would confirm the id exists, and these ids are the only thing
// separating two people's histories.
//
// WHAT UNKEEP MEANS
// -----------------
// Retention runs SEVEN DAYS FROM GENERATION. Keeping pauses that; unkeeping
// restores the original window rather than starting a new one, because a
// keep/unkeep cycle is not a way to buy another week. A result unkept after its
// window has already passed is therefore due immediately — so the response says
// `expired: true` and the page warns before it asks.

import { NextResponse } from 'next/server'
import { deleteResult, HISTORY_COLUMNS, type HistoryRow } from '@/lib/imageEditor/history'
import { HISTORY_BUCKET, isExpired } from '@/lib/imageEditor/retention'
import { authorizeHistoryCaller, NOT_FOUND } from '@/lib/imageEditor/historyServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Next 16 hands route params as a promise. */
type Context = { params: Promise<{ id: string }> }

/** A uuid, checked before it reaches a query. An id of the wrong shape is a 404
 *  rather than a database error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(req: Request, ctx: Context) {
  const auth = await authorizeHistoryCaller(req)
  if (!auth.ok) return auth.response
  const { svc, userId } = auth

  const { id } = await ctx.params
  if (!UUID.test(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })

  let kept: unknown
  try {
    kept = (await req.json())?.kept
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 })
  }
  if (typeof kept !== 'boolean') {
    return NextResponse.json({ error: 'Keep must be true or false.' }, { status: 400 })
  }

  // `kept` is the ONLY column this route writes. expires_at is never touched —
  // it is the database's record of when the seven days end, and an endpoint
  // that could move it would be an endpoint that could grant unlimited
  // retention to anyone who could call it.
  const { data, error } = await svc
    .from('image_editor_results')
    .update({ kept })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, kept, expires_at')
    .maybeSingle()

  if (error) {
    console.error('[image-editor/results] keep failed:', error.message)
    return NextResponse.json({ error: 'That result could not be updated.' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })

  return NextResponse.json({
    id: data.id,
    kept: data.kept,
    expiresAt: data.expires_at,
    // True when this result is now past its window and will go in the next
    // sweep. The page needs this to tell the truth about what unkeeping did.
    expired: isExpired({ kept: data.kept, expiresAt: data.expires_at }),
  })
}

export async function DELETE(req: Request, ctx: Context) {
  const auth = await authorizeHistoryCaller(req)
  if (!auth.ok) return auth.response
  const { svc, userId } = auth

  const { id } = await ctx.params
  if (!UUID.test(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })

  // Read the row first: the storage path lives on it, and after the row is gone
  // there is no way to find the object. See the ordering note in history.ts.
  const { data, error } = await svc
    .from('image_editor_results')
    .select(HISTORY_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('[image-editor/results] delete lookup failed:', error.message)
    return NextResponse.json({ error: 'That result could not be deleted.' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })

  const row = data as HistoryRow

  const outcome = await deleteResult(
    {
      storage: svc.storage.from(HISTORY_BUCKET),
      // Scoped to the owner a second time. The row was already fetched under
      // that filter, but the delete states it too so the statement is safe read
      // on its own.
      deleteRow: async (rowId, ownerId) => {
        const { error: delErr } = await svc
          .from('image_editor_results')
          .delete()
          .eq('id', rowId)
          .eq('user_id', ownerId)
        return { error: delErr ? { message: delErr.message } : null }
      },
    },
    row,
  )

  if (!outcome.ok) {
    console.error(
      '[image-editor/results] delete failed at the', outcome.stage, 'stage:', outcome.reason,
    )
    // Nothing partial is reported as success. The row survives a failed object
    // delete, so the picture is still listed and the employee can try again —
    // which is the whole reason the object goes first.
    return NextResponse.json({ error: 'That result could not be deleted.' }, { status: 500 })
  }

  return NextResponse.json({ id, deleted: true })
}
