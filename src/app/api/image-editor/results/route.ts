// GET /api/image-editor/results
//
// The signed-in employee's own generated masters, newest first. Nobody else's,
// including an administrator's — see the NO ADMIN BACK DOOR note in
// 20261022000000.
//
// MAKES NO PROVIDER CALL AND SPENDS NOTHING. This route reads a table and signs
// some URLs; FAL_KEY is not imported, not read and not reachable from here.
//
// EXPIRY IS APPLIED HERE, NOT ONLY BY THE SWEEP
// ---------------------------------------------
// The filter is `kept OR expires_at > now`, the same predicate the nightly
// cleanup inverts. That is what makes the seven days real regardless of the
// scheduler: a result that has passed its window stops being listed the instant
// it does, whether or not anything has deleted it yet. A cron that fails leaves
// bytes behind; it cannot resurrect an expired picture.

import { NextResponse } from 'next/server'
import {
  HISTORY_COLUMNS, toHistoryResult, type HistoryRow, type HistoryResult,
} from '@/lib/imageEditor/history'
import {
  HISTORY_BUCKET, HISTORY_PAGE_SIZE, SIGNED_URL_TTL_SECONDS, visibleFilter,
} from '@/lib/imageEditor/retention'
import { authorizeHistoryCaller } from '@/lib/imageEditor/historyServer'

export const runtime = 'nodejs'

// Never cached. A listing carries signed URLs and one person's private
// pictures; a shared or stale cache entry is the one thing it must not become.
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = await authorizeHistoryCaller(req)
  if (!auth.ok) return auth.response

  const { svc, userId } = auth

  // One instant for the whole request, so the filter cannot straddle a second
  // boundary between the query and the labels the page computes from it.
  const nowIso = new Date().toISOString()

  const { data, error } = await svc
    .from('image_editor_results')
    .select(HISTORY_COLUMNS)
    // The ownership filter. The service role bypasses RLS, so this line — not
    // the policy — is what keeps one employee out of another's history.
    .eq('user_id', userId)
    .or(visibleFilter(nowIso))
    .order('created_at', { ascending: false })
    .limit(HISTORY_PAGE_SIZE)

  if (error) {
    console.error('[image-editor/results] read failed:', error.message)
    return NextResponse.json({ error: 'Your recent results could not be loaded.' }, { status: 500 })
  }

  const rows = (data ?? []) as HistoryRow[]
  if (rows.length === 0) return NextResponse.json({ results: [] })

  // One batched signing call rather than one per row. A signing failure is not
  // fatal: the row is returned with a null url and the card shows the result
  // without a picture, which is more honest than an empty list.
  const paths = rows.map(r => r.storage_path)
  const { data: signed, error: signError } = await svc
    .storage
    .from(HISTORY_BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)

  if (signError) {
    console.warn('[image-editor/results] signing failed:', signError.message)
  }

  const urlByPath = new Map<string, string>()
  for (const entry of signed ?? []) {
    if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl)
  }

  const results: HistoryResult[] = rows.map(row =>
    toHistoryResult(row, urlByPath.get(row.storage_path) ?? null),
  )

  return NextResponse.json({ results })
}
