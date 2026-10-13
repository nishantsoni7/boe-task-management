import { NextRequest, NextResponse } from 'next/server'
import { parsePiWorkbook, toPiPreview, PiParseError } from '@/lib/meetings/piImport'
import { authorizePiImporter, rejectPiFile } from '@/lib/meetings/piRequest'

// Parse a BOE Proforma Invoice and return a PREVIEW.
//
// This route WRITES NOTHING — not a row, not a storage object, not a byte of the
// workbook. It turns an uploaded file into the product list plus warnings so the
// user sees exactly what will happen before confirming. The write is the
// separate /confirm route, which re-parses the file rather than trusting
// anything the browser sends back.
//
// Parsing is server-side for the same reason /api/meetings/import is: it keeps
// the workbook reader out of the client bundle, and it keeps the workbook — a
// document full of customer and pricing detail — off the browser entirely. Only
// the product list crosses back, and the parser never reads a price or a total
// in the first place.
//
// THE WORKBOOK IS NEVER STORED. It exists as a buffer for one request.

export async function POST(req: NextRequest) {
  const token = await authorizePiImporter(req)
  if (!token) {
    return NextResponse.json(
      { error: 'You do not have permission to import into meetings.' },
      { status: 403 },
    )
  }

  let file: File | null = null
  try {
    const form = await req.formData()
    file = form.get('file') as File | null
  } catch {
    return NextResponse.json({ error: 'Could not read the uploaded file.' }, { status: 400 })
  }

  const rejection = rejectPiFile(file)
  if (rejection) return NextResponse.json({ error: rejection.error }, { status: rejection.status })

  try {
    const bytes = new Uint8Array(await file!.arrayBuffer())
    return NextResponse.json(toPiPreview(parsePiWorkbook(bytes)))
  } catch (err) {
    if (err instanceof PiParseError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    // Never echo an internal message: the workbook is a customer document.
    console.error('[meetings:import-pi] parse failed')
    return NextResponse.json({ error: 'That PI could not be read.' }, { status: 500 })
  }
}
