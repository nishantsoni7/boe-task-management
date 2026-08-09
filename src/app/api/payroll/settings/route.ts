// GET  /api/payroll/settings   — the active calculation settings, plus history
// PUT  /api/payroll/settings   — save a new settings row
//
// Admin only, both verbs, through the same requireAdmin the rest of the payroll
// API uses. These are the parameters every employee's salary is calculated
// from; there is no self-service view of them and no read for a non-admin.
//
// The route runs on the service role, which bypasses RLS entirely, so
// requireAdmin here IS the boundary — the admin-only policies in migration
// 20260828000000 are the second line, for any caller that reaches the table
// without going through this route.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { parsePayrollSettings, DEFAULT_PAYROLL_SETTINGS } from '@/lib/payroll/settings'
import {
  fetchActiveSettings,
  saveSettings,
  fetchSettingsHistory,
} from '@/lib/payroll/settingsStore'

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const active = await fetchActiveSettings(svc)

  // History is presentational — a failure to read it must not stop an admin
  // seeing or editing the settings themselves.
  const history = await fetchSettingsHistory(svc).catch(err => {
    console.error('[payroll/settings] history:', err)
    return []
  })

  // Who saved each version, resolved in one read rather than per row.
  const actorIds = [...new Set(history.map(h => h.created_by).filter((v): v is string => v != null))]
  const names = new Map<string, string>()
  if (actorIds.length > 0) {
    const { data } = await svc.from('users').select('id, full_name').in('id', actorIds)
    for (const u of (data ?? []) as { id: string; full_name: string }[]) names.set(u.id, u.full_name)
  }

  return NextResponse.json({
    settings: active.settings,
    defaults: DEFAULT_PAYROLL_SETTINGS,
    active_row: active.id == null ? null : {
      id:         active.id,
      created_at: active.created_at,
      created_by: active.created_by,
      created_by_name: active.created_by ? names.get(active.created_by) ?? null : null,
    },
    // True when no usable settings row existed and the built-in defaults are
    // being shown. Surfaced so the page can say so rather than presenting
    // defaults as though an admin had chosen them.
    using_defaults: active.fell_back,
    history: history.map(h => ({
      id:         h.id,
      created_at: h.created_at,
      created_by_name: h.created_by ? names.get(h.created_by) ?? null : null,
      note:       h.note,
    })),
  })
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = body as { settings?: unknown; note?: unknown } | null
  if (payload == null || typeof payload !== 'object') {
    return NextResponse.json({ error: 'A settings object is required.' }, { status: 400 })
  }

  // Validated here, in full, before anything is stored. The database CHECK
  // covers the values that would break the calculation outright; this covers the
  // whole schema, including the cross-field rules SQL would be a poor place to
  // express.
  const parsed = parsePayrollSettings(payload.settings)
  if (!parsed.ok) {
    return NextResponse.json(
      { error: 'Some values are not valid.', issues: parsed.issues },
      { status: 422 },
    )
  }

  const note = typeof payload.note === 'string' && payload.note.trim().length > 0
    ? payload.note.trim().slice(0, 500)
    : null

  try {
    // An INSERT, never an UPDATE: the table is append-only, so this row IS the
    // audit record of who changed what and when. auth.id comes from the bearer
    // token, never from the body.
    const saved = await saveSettings(svc, parsed.settings, auth.id, note)
    return NextResponse.json({
      settings: parsed.settings,
      saved: { id: saved.id, created_at: saved.created_at },
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
