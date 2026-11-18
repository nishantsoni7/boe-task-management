// POST /api/quotations/picture-mark  { path }
//
// Logo marks on quotation pictures (owner, 18 Nov 2026). A new picture is first stored clean in the private
// 'quotation-originals' bucket by the browser; this route reads it as the caller, puts the Best of Exports mark on it
// (src/lib/quotations/pictureMark.ts) and writes the marked copy to the public 'quotation-images' bucket at the SAME
// path, which is what the client link, the PDF and the screens show. Only the person who uploaded it may ask (the path
// starts with their id), and only with quotation create or edit access: the same people as the upload itself.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { markPicture } from '@/lib/quotations/pictureMark'
import { storedPictureProblem } from '@/lib/quotations/pictureStore'

export const runtime = 'nodejs'
export const maxDuration = 30

const fail = (status: number, code: string, error: string) => NextResponse.json({ ok: false, code, error }, { status })

export async function POST(req: NextRequest) {
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const path = body.path
  const problem = storedPictureProblem(path, user.id)
  if (problem) return fail(400, 'BAD_REQUEST', problem)

  const { data: access, error: accessErr } = await s.rpc('quotation_my_access')
  const a = (access ?? {}) as { create?: boolean; edit?: boolean; admin?: boolean }
  if (accessErr || !(a.create || a.edit || a.admin)) return fail(403, 'FORBIDDEN', 'Your access cannot change quotation pictures.')

  const { data: blob, error: readErr } = await s.storage.from('quotation-originals').download(path as string)
  if (readErr || !blob) return fail(404, 'SOURCE_MISSING', 'That picture could not be found. Upload it again.')
  let marked: Buffer
  try { marked = await markPicture(Buffer.from(await blob.arrayBuffer())) } catch { return fail(422, 'SOURCE_UNREADABLE', 'That picture could not be read. Upload it again.') }

  const { error } = await s.storage.from('quotation-images').upload(path as string, marked, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
  if (error && !/already exists|Duplicate/i.test(error.message ?? '')) return fail(500, 'NOT_STORED', 'The picture could not be stored. Please try again.')
  return NextResponse.json({ ok: true })
}
