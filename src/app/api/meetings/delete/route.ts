import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

// Administrator-only permanent deletion of a meeting and everything in it.
//
// The database does the deleting, in ONE transaction, through
// admin_delete_meeting() (20270326000000). That function re-checks the caller is
// an active administrator and returns the Storage keys that are no longer
// referenced by any row. This route runs it AS THE CALLER (their own token, so
// auth.uid() is theirs) and only then uses the service role for the one thing
// the caller cannot do: erase the files. Files go last so a failure leaves
// harmless orphans, never a meeting pointing at missing images.

const EVIDENCE_BUCKET = 'meeting-evidence'
const IMAGE_BUCKET    = 'meeting-product-images'
const CHUNK           = 100

type DeleteResult = {
  counts: Record<string, number>
  evidence_paths: string[]
  image_paths: string[]
}

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) {
    return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })
  }

  let meetingId = ''
  try {
    const body = await req.json()
    meetingId = String(body?.meeting_id ?? '')
  } catch {
    return NextResponse.json({ error: 'The request could not be read.' }, { status: 400 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(meetingId)) {
    return NextResponse.json({ error: 'A meeting is required.' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const asCaller = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await asCaller.rpc('admin_delete_meeting', { p_meeting_id: meetingId })
  if (error) {
    if (error.code === '42501') {
      return NextResponse.json({ error: 'Only an administrator can delete a meeting.' }, { status: 403 })
    }
    if (error.code === 'P0002') {
      return NextResponse.json({ error: 'This meeting no longer exists.' }, { status: 404 })
    }
    console.error('[meetings:delete] rpc failed', error)
    return NextResponse.json({ error: 'The meeting could not be deleted. Please try again.' }, { status: 500 })
  }

  const result = data as DeleteResult

  const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let filesFailed = 0
  const erase = async (bucket: string, paths: string[]) => {
    for (let i = 0; i < paths.length; i += CHUNK) {
      const { error: rmErr } = await svc.storage.from(bucket).remove(paths.slice(i, i + CHUNK))
      if (rmErr) {
        console.error('[meetings:delete] file cleanup failed', bucket, rmErr)
        filesFailed += Math.min(CHUNK, paths.length - i)
      }
    }
  }
  await erase(EVIDENCE_BUCKET, result.evidence_paths ?? [])
  await erase(IMAGE_BUCKET, result.image_paths ?? [])

  return NextResponse.json({ ok: true, counts: result.counts, filesFailed })
}
