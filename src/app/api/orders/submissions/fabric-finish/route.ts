import { createClient as createServiceClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { SUBMISSION_ID_RE } from '@/lib/orders/submissionFilesServer'
import { readFabricFinishSheets, type FabricFinishResult } from '@/lib/pi/fabricFinishSheets'

// THE FABRIC & FINISH SHEETS OF ONE PI, READ FROM THE STORED WORKBOOK.
//
// GET /api/orders/submissions/fabric-finish?submissionId=<uuid>
//
// WHY A ROUTE. The workbook lives in the private order-files bucket, whose
// read policy admits the PI's owner and the people the PI is visible to —
// but the browser never opens the workbook itself: a 3 MB ZIP inflated and
// parsed on a phone is the wrong place for it, and the parser already runs on
// the server for every upload. So the server reads it, with the service role,
// AFTER the caller's own session has proved it may see the PI.
//
// THE DOOR IS THE PI'S OWN. The row is read with the caller's client, under
// RLS: a PI the caller may not see comes back as no row and is answered as
// not found, exactly as the PI page would. Only then does the service role
// touch storage, and only to download the one path the row names — nothing
// the browser sent is used as a storage key.
//
// NOTHING IS WRITTEN AND NOTHING IS CACHED ACROSS CALLERS: the answer is a
// function of the stored bytes and is returned with no-store, so a replaced
// workbook is read afresh on the next open.

type Failure = { code: 'UNAUTHORIZED' | 'BAD_REQUEST' | 'NOT_FOUND' | 'NO_WORKBOOK' | 'STORAGE_FAILED' | 'UNREADABLE' | 'NOT_CONFIGURED'; status: number; message?: string }

const fail = ({ code, status, message }: Failure) =>
  NextResponse.json({ ok: false, code, ...(message ? { message } : {}) }, { status, headers: { 'Cache-Control': 'private, no-store' } })

export async function GET(req: NextRequest) {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail({ code: 'UNAUTHORIZED', status: 401 })

  const submissionId = req.nextUrl.searchParams.get('submissionId') ?? ''
  if (!SUBMISSION_ID_RE.test(submissionId)) return fail({ code: 'BAD_REQUEST', status: 400 })

  // The PI, under the caller's own RLS. No row = not visible = not found.
  const { data: row, error } = await authClient
    .from('order_submissions')
    .select('id, source_workbook_path')
    .eq('id', submissionId)
    .maybeSingle()
  if (error || !row) return fail({ code: 'NOT_FOUND', status: 404 })
  const path = (row as { source_workbook_path?: string | null }).source_workbook_path
  if (typeof path !== 'string' || path === '') {
    return fail({ code: 'NO_WORKBOOK', status: 409, message: 'This PI has no stored workbook to read.' })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return fail({ code: 'NOT_CONFIGURED', status: 500 })
  const service = createServiceClient(url, serviceKey)

  const download = await service.storage.from('order-files').download(path)
  if (download.error || !download.data) {
    return fail({ code: 'STORAGE_FAILED', status: 502, message: 'The stored workbook could not be downloaded.' })
  }
  const bytes = new Uint8Array(await download.data.arrayBuffer())

  let result: FabricFinishResult
  try {
    result = await readFabricFinishSheets(bytes)
  } catch {
    return fail({ code: 'UNREADABLE', status: 422, message: 'The stored workbook could not be read.' })
  }
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: result.reason, message: result.message, sheetNames: result.sheetNames },
      { status: 422, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  return NextResponse.json(
    { ok: true, sheets: result.sheets, sheetNames: result.sheetNames },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
