// ── Customize image Learning: the attempts list ──────────────────────────────
//
// GET   ?filter=wrong|unreviewed|all&before=<created_at>   newest first, 30 a page
// PATCH { id, action: 'dismiss' | 'reopen' }                 mark reviewed / not
//
// Trainers only (./guard.ts). Pictures come back as 10-minute signed links.

import { NextRequest, NextResponse } from 'next/server'
import { isUuid } from '@/lib/orders/submissionPayload'
import { ATTEMPTS, signPaths } from '@/lib/orders/customizationLearningServer'
import { dbFailure, fail, requireTrainer } from '../guard'

export const runtime = 'nodejs'

const PAGE = 30
const COLUMNS = 'id, created_at, created_by, submission_id, comment, product_name, pi_dimensions, pi_material, reference_count, '
  + 'understood_instruction, understood_assumptions, final_instruction, instruction_edited, applied_rule_ids, applied_example_ids, '
  + 'outcome, feedback, feedback_note, reviewed_at, source_path, result_path'

export async function GET(req: NextRequest) {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const { service } = gate

  const filter = req.nextUrl.searchParams.get('filter') ?? 'unreviewed'
  const before = req.nextUrl.searchParams.get('before')
  let q = service.from(ATTEMPTS).select(COLUMNS).order('created_at', { ascending: false }).limit(PAGE)
  if (filter === 'wrong') q = q.eq('feedback', 'wrong')
  else if (filter === 'unreviewed') q = q.is('reviewed_at', null)
  if (before && !Number.isNaN(Date.parse(before))) q = q.lt('created_at', before)
  const { data, error } = await q
  if (error) return dbFailure(error, 'attempts list')

  const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { created_by: string | null; source_path: string; result_path: string | null }>
  const ids = [...new Set(rows.map(r => r.created_by).filter((v): v is string => !!v))]
  const [people, links] = await Promise.all([
    ids.length ? service.from('users').select('id, full_name').in('id', ids) : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    signPaths(service, rows.flatMap(r => [r.source_path, r.result_path])),
  ])
  const nameOf = new Map(((people.data ?? []) as { id: string; full_name: string | null }[]).map(p => [p.id, p.full_name]))

  return NextResponse.json({
    ok: true,
    attempts: rows.map(r => ({
      ...r,
      created_by_name: r.created_by ? nameOf.get(r.created_by) ?? null : null,
      source_url: links[r.source_path] ?? null,
      result_url: r.result_path ? links[r.result_path] ?? null : null,
    })),
    more: rows.length === PAGE,
  })
}

export async function PATCH(req: NextRequest) {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  let body: Record<string, unknown>
  try { body = (await req.json()) as Record<string, unknown> } catch { return fail(400, 'BAD_REQUEST', 'The request could not be read.') }
  const id = typeof body.id === 'string' ? body.id : ''
  const action = body.action
  if (!isUuid(id) || (action !== 'dismiss' && action !== 'reopen')) return fail(400, 'BAD_REQUEST', 'The request could not be read.')
  const now = new Date().toISOString()
  const { error } = await gate.service.from(ATTEMPTS)
    .update(action === 'dismiss' ? { reviewed_by: gate.userId, reviewed_at: now, updated_at: now } : { reviewed_by: null, reviewed_at: null, updated_at: now })
    .eq('id', id)
  if (error) return dbFailure(error, 'review')
  return NextResponse.json({ ok: true })
}
