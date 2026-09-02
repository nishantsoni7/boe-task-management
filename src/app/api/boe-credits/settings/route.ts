// GET  /api/boe-credits/settings   — the active credit settings (+ history for an admin)
// PUT  /api/boe-credits/settings   — save a new settings row (admin only)
//
// Any signed-in employee may READ the two numbers: a later screen will tell
// them what a verified review earns. Only an admin may change them, through
// the same requireAdmin the rest of the payroll API uses. The table is
// append-only, so a save is an INSERT and the row itself is the audit record
// of who changed what and when.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, resolveCaller, isResponse, UNAUTHORIZED } from '@/lib/security/attendancePayrollApiAuth'
import { parseBoeCreditSettings, DEFAULT_BOE_CREDIT_SETTINGS } from '@/lib/boeCredits/settings'
import {
  fetchActiveCreditSettings,
  fetchCreditSettingsHistory,
  saveCreditSettings,
  CreditServiceError,
  creditErrorStatus,
} from '@/lib/boeCredits/service'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return UNAUTHORIZED()
  const svc = caller.svc

  const active = await fetchActiveCreditSettings(svc)

  // History is management-only and presentational — a failure to read it must
  // not stop anyone seeing the settings themselves.
  const history = caller.isAdmin
    ? await fetchCreditSettingsHistory(svc).catch(err => {
        console.error('[boe-credits/settings] history:', err)
        return []
      })
    : []

  const actorIds = [...new Set(history.map(h => h.created_by).filter((v): v is string => v != null))]
  const names = new Map<string, string>()
  if (actorIds.length > 0) {
    const { data } = await svc.from('users').select('id, full_name').in('id', actorIds)
    for (const u of (data ?? []) as { id: string; full_name: string }[]) names.set(u.id, u.full_name)
  }

  return NextResponse.json({
    settings: active.settings,
    defaults: DEFAULT_BOE_CREDIT_SETTINGS,
    using_defaults: active.fell_back,
    history: history.map(h => ({
      id: h.id,
      review_reward_credits: h.review_reward_credits,
      credit_value: h.credit_value,
      note: h.note,
      created_at: h.created_at,
      created_by_name: h.created_by ? names.get(h.created_by) ?? null : null,
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

  const parsed = parseBoeCreditSettings(payload.settings)
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Some values are not valid.', issues: parsed.issues }, { status: 422 })
  }

  const note = typeof payload.note === 'string' && payload.note.trim().length > 0
    ? payload.note.trim().slice(0, 500)
    : null

  try {
    // An INSERT, never an UPDATE. auth.id comes from the bearer token, never
    // from the body.
    const saved = await saveCreditSettings(svc, parsed.settings, auth.id, note)
    return NextResponse.json({ settings: parsed.settings, saved: { id: saved.id, created_at: saved.created_at } })
  } catch (e) {
    if (e instanceof CreditServiceError) {
      return NextResponse.json({ error: e.message }, { status: creditErrorStatus(e) })
    }
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
