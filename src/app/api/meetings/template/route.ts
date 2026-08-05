import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { IMPORT_TEMPLATE_COLUMNS, IMPORT_TEMPLATE_HEADERS } from '@/lib/meetings/import'

// The blank BOE meeting-review template.
//
// Generated rather than checked in as a binary, so the file a user downloads
// can never drift from IMPORT_TEMPLATE_COLUMNS — the same constant the parser
// and the preview validate against. `xlsx` is already a project dependency
// (Attendance import, Order Request PI export); nothing new was added for this.
//
// Two sheets, and the split matters. The FIRST sheet carries the header row and
// nothing else, because the parser reads the first sheet and a helpful "example
// row" left in place is an order number nobody meant to import. The guidance —
// what each column wants, and one filled example — lives on a second "How to
// fill" sheet, where it can be as verbose as it needs to be without ever
// becoming data.

// Authorization is module ENTRY, not the import permission: this is a blank
// spreadsheet with no BOE data in it. Whether the filled version can actually
// be imported is decided by import_meeting_rows() against the target meeting.
async function authorize(req: NextRequest): Promise<boolean> {
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

  const { data: allowed } = await svc.rpc('resolve_permission', {
    p_user_id: user.id,
    p_module_key: 'meetings',
    p_action_key: 'view',
  })
  return allowed === true
}

export async function GET(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const EXAMPLE: (string | number)[] = [
    '2041', 'New Order', 'Leela Hotel', '2026-09-15', 'BOE-CH-118', 'Chesterfield Armchair',
    4, 'Polishing', 'Frames done, polish starts Monday', 'Fabric shade pending approval',
    'operations', '2026-08-12',
  ]

  // Sheet 1 — the one the parser reads. Headers only.
  const sheet = XLSX.utils.aoa_to_sheet([[...IMPORT_TEMPLATE_HEADERS]])
  // Column widths sized to their headers so the file opens readable rather than
  // as twelve identical narrow columns.
  sheet['!cols'] = IMPORT_TEMPLATE_COLUMNS.map(c => ({ wch: Math.max(14, c.header.length + 2) }))

  // Sheet 2 — guidance, one row per column, never parsed.
  const guide = XLSX.utils.aoa_to_sheet([
    ['Column', 'Required?', 'What to put in it', 'Example'],
    ...IMPORT_TEMPLATE_COLUMNS.map((c, i) => [
      c.header,
      c.required ? 'Required' : 'Optional',
      c.hint,
      String(EXAMPLE[i] ?? ''),
    ]),
    [],
    ['Rows are matched on Order Number + SKU.'],
    ['A matching row is UPDATED. A new one is ADDED. Nothing is ever deleted,'],
    ['and a blank cell leaves the existing value alone.'],
  ])
  guide['!cols'] = [{ wch: 24 }, { wch: 11 }, { wch: 54 }, { wch: 32 }]

  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Meeting Review')
  XLSX.utils.book_append_sheet(book, guide, 'How to fill')

  const buffer: Buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="BOE-Meeting-Review-Template.xlsx"',
      'Cache-Control': 'no-store',
    },
  })
}
