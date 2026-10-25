// ── Customize image Learning: approved examples ──────────────────────────────
//
// GET                                                       every example, newest first
// POST  { attemptId?, comment, instruction, keywords?,      approve an example ("Teach from this");
//         productName?, piDimensions? }                     from an attempt, its pictures are COPIED
//                                                           and the attempt is marked reviewed
// PATCH { id, instruction?, keywords?, is_active? }         edit or switch on/off
//
// Trainers only (./guard.ts). The most similar ACTIVE examples are given to
// Check understanding (customizationLearning.ts rankExamples).

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { isUuid } from '@/lib/orders/submissionPayload'
import { instructionProblem, INSTRUCTION_MESSAGES } from '@/lib/orders/customizationImage'
import { keywordsFrom, normaliseKeywords } from '@/lib/orders/customizationLearning'
import { ATTEMPTS, EXAMPLES, copyExamplePicture, signPaths } from '@/lib/orders/customizationLearningServer'
import { dbFailure, fail, requireTrainer } from '../guard'

export const runtime = 'nodejs'

const COLUMNS = 'id, attempt_id, product_name, pi_dimensions, comment, instruction, keywords, before_path, after_path, is_active, created_at, updated_at'

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function GET() {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const { data, error } = await gate.service.from(EXAMPLES).select(COLUMNS)
    .order('is_active', { ascending: false }).order('created_at', { ascending: false }).limit(200)
  if (error) return dbFailure(error, 'examples list')
  const rows = (data ?? []) as Array<Record<string, unknown> & { before_path: string | null; after_path: string | null }>
  const links = await signPaths(gate.service, rows.flatMap(r => [r.before_path, r.after_path]))
  return NextResponse.json({
    ok: true,
    examples: rows.map(r => ({
      ...r,
      before_url: r.before_path ? links[r.before_path] ?? null : null,
      after_url: r.after_path ? links[r.after_path] ?? null : null,
    })),
  })
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try { return (await req.json()) as Record<string, unknown> } catch { return null }
}

export async function POST(req: NextRequest) {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const { service, userId } = gate
  const body = await readBody(req)
  if (!body) return fail(400, 'BAD_REQUEST', 'The request could not be read.')

  const comment = text(body.comment, 1500)
  const instruction = text(body.instruction, 1500)
  if (comment === '') return fail(400, 'EXAMPLE_INVALID', 'Say what the salesperson wrote.')
  const problem = instructionProblem(instruction)
  if (problem) return fail(400, 'EXAMPLE_INVALID', INSTRUCTION_MESSAGES[problem])
  const attemptId = typeof body.attemptId === 'string' && isUuid(body.attemptId) ? body.attemptId : null

  // From an attempt: its pictures, read from the row, never from the request.
  type AttemptPictures = { source_path: string; result_path: string | null; product_name: string | null; pi_dimensions: string | null }
  let attempt: AttemptPictures | null = null
  if (attemptId) {
    const { data, error } = await service.from(ATTEMPTS)
      .select('source_path, result_path, product_name, pi_dimensions').eq('id', attemptId).maybeSingle()
    if (error) return dbFailure(error, 'attempt')
    if (!data) return fail(404, 'NOT_FOUND', 'That attempt no longer exists (its PI may have been deleted).')
    attempt = data as AttemptPictures
  }

  const productName = text(body.productName, 300) || attempt?.product_name || null
  const piDimensions = text(body.piDimensions, 500) || attempt?.pi_dimensions || null
  const typed = body.keywords !== undefined ? normaliseKeywords(body.keywords as string | string[]) : []
  const keywords = typed.length > 0 ? typed : keywordsFrom(comment, productName ?? '')

  const id = randomUUID()
  const [beforePath, afterPath] = attempt
    ? await Promise.all([
        copyExamplePicture(service, id, 'before', attempt.source_path),
        copyExamplePicture(service, id, 'after', attempt.result_path),
      ])
    : [null, null]

  const { data, error } = await service.from(EXAMPLES).insert({
    id, attempt_id: attemptId, product_name: productName, pi_dimensions: piDimensions,
    comment, instruction, keywords, before_path: beforePath, after_path: afterPath, approved_by: userId,
  }).select(COLUMNS).single()
  if (error) return dbFailure(error, 'example')

  if (attemptId) {
    const now = new Date().toISOString()
    await service.from(ATTEMPTS).update({ reviewed_by: userId, reviewed_at: now, updated_at: now }).eq('id', attemptId)
  }
  return NextResponse.json({ ok: true, example: data, picturesCopied: !!beforePath })
}

export async function PATCH(req: NextRequest) {
  const gate = await requireTrainer()
  if (!gate.ok) return gate.response
  const body = await readBody(req)
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!body || !isUuid(id)) return fail(400, 'BAD_REQUEST', 'The request could not be read.')
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.instruction !== undefined) {
    const instruction = text(body.instruction, 1500)
    const problem = instructionProblem(instruction)
    if (problem) return fail(400, 'EXAMPLE_INVALID', INSTRUCTION_MESSAGES[problem])
    patch.instruction = instruction
  }
  if (body.keywords !== undefined) patch.keywords = normaliseKeywords(body.keywords as string | string[])
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return fail(400, 'BAD_REQUEST', 'The request could not be read.')
    patch.is_active = body.is_active
  }
  const { data, error } = await gate.service.from(EXAMPLES).update(patch).eq('id', id).select(COLUMNS).maybeSingle()
  if (error) return dbFailure(error, 'example')
  if (!data) return fail(404, 'NOT_FOUND', 'That example no longer exists.')
  return NextResponse.json({ ok: true, example: data })
}
