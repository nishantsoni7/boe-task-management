// ── Customize image Learning: house rules ────────────────────────────────────
//
// GET                                   every rule, active first
// POST  { rule_text }                   add a rule (active)
// PATCH { id, rule_text?, is_active? }  edit or switch on/off
//
// Trainers only (./guard.ts). Every ACTIVE rule is given to Check understanding.

import { NextRequest, NextResponse } from 'next/server'
import { isUuid } from '@/lib/orders/submissionPayload'
import { ruleTextProblem } from '@/lib/orders/customizationLearning'
import { RULES } from '@/lib/orders/customizationLearningServer'
import { dbFailure, fail, requireTrainer } from '../guard'

export const runtime = 'nodejs'

const COLUMNS = 'id, rule_text, is_active, source, created_at, updated_at'

export async function GET() {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const { data, error } = await gate.service.from(RULES).select(COLUMNS)
    .order('is_active', { ascending: false }).order('created_at', { ascending: true })
  if (error) return dbFailure(error, 'rules list')
  return NextResponse.json({ ok: true, rules: data ?? [] })
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { return (await req.json()) as Record<string, unknown> } catch { return null }
}

export async function POST(req: NextRequest) {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const body = await readBody(req)
  const problem = ruleTextProblem(body?.rule_text)
  if (!body || problem) return fail(400, 'RULE_INVALID', problem ?? 'The request could not be read.')
  const { data, error } = await gate.service.from(RULES)
    .insert({ rule_text: String(body.rule_text).trim(), source: 'admin', created_by: gate.userId, updated_by: gate.userId })
    .select(COLUMNS).single()
  if (error) return dbFailure(error, 'rule')
  return NextResponse.json({ ok: true, rule: data })
}

export async function PATCH(req: NextRequest) {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const body = await readBody(req)
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!body || !isUuid(id)) return fail(400, 'BAD_REQUEST', 'The request could not be read.')
  const patch: Record<string, unknown> = { updated_by: gate.userId, updated_at: new Date().toISOString() }
  if (body.rule_text !== undefined) {
    const problem = ruleTextProblem(body.rule_text)
    if (problem) return fail(400, 'RULE_INVALID', problem)
    patch.rule_text = String(body.rule_text).trim()
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return fail(400, 'BAD_REQUEST', 'The request could not be read.')
    patch.is_active = body.is_active
  }
  const { data, error } = await gate.service.from(RULES).update(patch).eq('id', id).select(COLUMNS).maybeSingle()
  if (error) return dbFailure(error, 'rule')
  if (!data) return fail(404, 'NOT_FOUND', 'That rule no longer exists.')
  return NextResponse.json({ ok: true, rule: data })
}
