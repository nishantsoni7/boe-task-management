import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { buildImportPreview, type RawSheetRow } from '@/lib/meetings/import'

// Parse an uploaded BOE meeting-review sheet and return a PREVIEW.
//
// This route writes nothing. It turns a file into validated rows plus the list
// of rows that failed, so the user can see exactly what will happen before
// confirming. The write is a separate, deliberate step: the browser then calls
// `import_meeting_rows`, which re-validates and re-authorizes, because a client
// is not a validator.
//
// Parsing happens here rather than in the browser so the xlsx parser stays out
// of the client bundle — the same reason /api/attendance/preview exists.

const MAX_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 2000

/** Signed-in, active, and holds Meetings edit or manage (or is an admin). */
async function authorizeImporter(req: NextRequest): Promise<boolean> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return false

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error } = await svc.auth.getUser(token)
  if (error || !user) return false

  const { data: profile } = await svc
    .from('users').select('role, is_active').eq('id', user.id).single()
  if (!profile || profile.is_active !== true) return false
  if (profile.role === 'admin') return true

  // Either grant is enough — both are the authority to record updates in a
  // meeting, which is what an import does.
  for (const action of ['edit', 'manage']) {
    const { data: allowed } = await svc.rpc('resolve_permission', {
      p_user_id: user.id,
      p_module_key: 'meetings',
      p_action_key: action,
    })
    if (allowed === true) return true
  }
  return false
}

export async function POST(req: NextRequest) {
  if (!(await authorizeImporter(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let buffer: Buffer
  let fileName = ''
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }
    fileName = (file as File).name
    if ((file as File).size > MAX_BYTES) {
      return NextResponse.json({ error: 'That file is larger than 5 MB.' }, { status: 400 })
    }
    buffer = Buffer.from(await (file as File).arrayBuffer())
  } catch {
    return NextResponse.json({ error: 'Could not read the uploaded file.' }, { status: 400 })
  }

  let rows: RawSheetRow[]
  try {
    // cellDates so a real date cell arrives as a Date rather than an Excel
    // serial. parseSheetDate handles the serial too, because a column formatted
    // as General never becomes one.
    const book = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const sheetName = book.SheetNames[0]
    if (!sheetName) {
      return NextResponse.json({ error: 'That file has no sheets in it.' }, { status: 400 })
    }
    // Only the FIRST sheet is read. The template's second sheet is guidance,
    // and reading every sheet would import it.
    rows = XLSX.utils.sheet_to_json<RawSheetRow>(book.Sheets[sheetName], { defval: null, raw: true })
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read that spreadsheet: ${(e as Error).message}` },
      { status: 400 },
    )
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'That sheet has no rows below the header.' }, { status: 400 })
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `That sheet has ${rows.length} rows. Import up to ${MAX_ROWS} at a time.` },
      { status: 400 },
    )
  }

  const preview = buildImportPreview(rows)

  if (preview.missingHeaders.length > 0) {
    return NextResponse.json({
      error:
        `This does not look like the BOE meeting review template. Missing ${preview.missingHeaders.length === 1 ? 'column' : 'columns'}: `
        + `${preview.missingHeaders.join(', ')}. Download the blank template and fill that instead.`,
      missingHeaders: preview.missingHeaders,
    }, { status: 400 })
  }

  return NextResponse.json({ fileName, ...preview })
}
