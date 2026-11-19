// GET /api/quotations/picture-file?path=<picture>&t=<client link token>   (the client link)
// GET /api/quotations/picture-file?path=<picture>&q=<quotation id>        (a signed-in person)
//
// Which picture a viewer gets (owner, 18 Nov 2026): the logo mark is optional per quotation. With the mark ON (the
// default) the answer is a redirect to the marked copy in the public bucket. With it OFF, the clean original from the
// private bucket is returned, but only for a picture this quotation really uses, and only to its own client link or to
// someone who may see the quotation. The clean file is never given a public address.

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { ORIGINALS_BUCKET, PICTURE_HOLDERS, linePictureFilter, pictureRequestProblem } from '@/lib/quotations/pictureStore'

export const runtime = 'nodejs'

const gone = (status: number) => new NextResponse(null, { status })

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const path = sp.get('path'), token = sp.get('t'), id = sp.get('q')
  if (pictureRequestProblem(path, token, id)) return gone(400)

  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  let quotationId: string
  let markOn: boolean

  if (token) {
    const { data: q } = await service.from('quotations').select('id').eq('share_token', token).neq('status', 'archived').maybeSingle()
    if (!q) return gone(404)
    quotationId = q.id as string
    const { data: m } = await service.from('quotation_picture_marks').select('enabled').eq('quotation_id', quotationId).maybeSingle()
    markOn = m ? !!m.enabled : true
  } else {
    const s = await createClient()
    const { data: { user } } = await s.auth.getUser()
    if (!user) return gone(401)
    const { data } = await s.rpc('quotation_picture_mark_get', { p_id: id })
    if (typeof data !== 'boolean') return gone(404) // not visible to this person
    quotationId = id as string
    markOn = data
  }

  if (markOn) {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, '')
    return NextResponse.redirect(`${base}/storage/v1/object/public/quotation-images/${path}`, 302)
  }

  // Mark OFF: the picture must belong to this quotation, in its lines (a product's picture or a client-choice swatch) or in a version it has sent.
  const used = await service.from('quotation_lines').select('id').eq('quotation_id', quotationId).or(linePictureFilter(path as string)).limit(1)
  let belongs = (used.data ?? []).length > 0
  if (!belongs) {
    const found = await Promise.all(PICTURE_HOLDERS(path as string).map(h => service.from('quotation_versions').select('version_no').eq('quotation_id', quotationId)
      .contains('doc', { lines: [h] }).limit(1)))
    belongs = found.some(v => (v.data ?? []).length > 0)
  }
  if (!belongs) return gone(404)

  const { data: blob, error } = await service.storage.from(ORIGINALS_BUCKET).download(path as string)
  if (error || !blob) return gone(404)
  return new NextResponse(Buffer.from(await blob.arrayBuffer()), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' },
  })
}
