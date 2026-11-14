// Price learning, piece 1: thin typed wrappers over the database functions of 20270715000000. Every function reads
// auth.uid() itself, so the browser's own session is the identity; no API route sits in between.

import type { createClient } from '@/lib/supabase/client'
import { classifyError } from '@/lib/quotations/api'
import type { buildSaveDoc } from './batch'

type Supabase = ReturnType<typeof createClient>

export const learningKeys = {
  desk: ['pricing', 'learning', 'desk'] as const,
  home: ['pricing', 'learning', 'home'] as const,
  batch: (id: string) => ['pricing', 'learning', 'batch', id] as const,
  feedback: (openOnly: boolean) => ['pricing', 'learning', 'feedback', openOnly] as const,
}

export type LearningBatchRow = {
  id: string; batch_no: number; created_at: string; pis_learned: number; pis_left_out: number; lines_learned: number
  priced_lines: number; unpriced_lines: number; avg_miss: number | null; hit_rate: number | null; client_type: string | null
}
export type LearningHome = { batches: LearningBatchRow[]; totals: { pis: number; lines: number }; open_feedback: number }
export type LearningPiRow = {
  id: string; seq: number; label: string | null; pi_date: string; date_source: string; client_type: string | null; pieces: number; designs: number
  subtotal: number; discount: number | null; value_before_gst: number; left_out: boolean; left_out_reason: string | null; lines: number
}
export type LearningBatch = { batch: LearningBatchRow & { created_by_name: string | null; note: string | null }; pis: LearningPiRow[] }

export type FeedbackKind = 'too_high' | 'too_low' | 'wrong_type' | 'misread' | 'other' | 'correction'
export type FeedbackDoc = {
  source: 'quotation' | 'learning'
  kind: FeedbackKind
  comment: string | null
  expected_price: number | null
  line: { name: string; size?: string | null; material?: string | null; finish?: string | null; qty?: number | null }
  client_type: string | null
  suggestion: { price: number; low: number; high: number; confidence: string; reasons: string[]; basis: string } | null
  quotation_id: string | null
}
export type FeedbackRow = {
  id: string; created_at: string; source: 'quotation' | 'learning'; kind: FeedbackKind; comment: string | null; expected_price: number | null
  line_name: string | null; line_size: string | null; line_material: string | null; line_finish: string | null; line_qty: number | null
  client_type: string | null; suggestion: FeedbackDoc['suggestion']; quotation_id: string | null; quote_no: string | null
  status: 'new' | 'seen' | 'done' | 'declined'; handled_at: string | null; handled_note: string | null; from_name: string | null
}

export class LearningError extends Error {
  constructor(public kind: 'not_set_up' | 'forbidden' | 'duplicate' | 'invalid' | 'network' | 'unknown', message: string) { super(message) }
}
const after = (m: string, code: string) => m.replace(new RegExp(`^.*${code}:\\s*`), '')

export function classifyLearning(err: { message?: string; code?: string; status?: number }): LearningError {
  const m = err.message ?? ''
  if (/PRICING_LEARNING_FORBIDDEN/.test(m)) return new LearningError('forbidden', 'Price learning is for the pricing desk.')
  if (/PRICING_LEARNING_DUPLICATE/.test(m)) return new LearningError('duplicate', after(m, 'PRICING_LEARNING_DUPLICATE'))
  if (/PRICING_LEARNING_INVALID|PRICING_FEEDBACK_INVALID/.test(m)) return new LearningError('invalid', after(after(m, 'PRICING_LEARNING_INVALID'), 'PRICING_FEEDBACK_INVALID'))
  if (/PRICING_FEEDBACK_LIMIT/.test(m)) return new LearningError('invalid', after(m, 'PRICING_FEEDBACK_LIMIT'))
  const base = classifyError(err)
  if (base.kind === 'not_set_up') return new LearningError('not_set_up', 'Price learning is being set up: its database part has not been applied yet.')
  if (base.kind === 'forbidden') return new LearningError('forbidden', base.message)
  if (base.kind === 'network') return new LearningError('network', base.message)
  return new LearningError('unknown', m || 'Something went wrong.')
}
export const learningErrorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')
export const learningErrorKind = (e: unknown) => (e instanceof LearningError ? e.kind : 'unknown')

type Raw = { message?: string; code?: string; status?: number }
type RpcResult<T> = { data: T | null; error: Raw | null }
async function call<T>(run: () => PromiseLike<RpcResult<T>>): Promise<T> {
  let res: RpcResult<T>
  try { res = await run() } catch (e) { throw classifyLearning({ message: e instanceof Error ? e.message : 'Failed to fetch', status: 0 }) }
  if (res.error) throw classifyLearning(res.error)
  return res.data as T
}

export const fetchDesk = async (s: Supabase) => (await call<{ desk: boolean }>(() => s.rpc('pricing_learning_access'))).desk
export const fetchHome = (s: Supabase) => call<LearningHome>(() => s.rpc('pricing_learning_home'))
export const fetchBatch = (s: Supabase, id: string) => call<LearningBatch>(() => s.rpc('pricing_learning_batch', { p_id: id }))
export const fetchKnown = (s: Supabase, hashes: string[], prints: string[]) =>
  call<{ file_hash: string; content_print: string; batch_no: number; left_out: boolean; reason: string | null }[]>(() => s.rpc('pricing_learning_known', { p_hashes: hashes, p_prints: prints }))
export const saveBatch = (s: Supabase, doc: ReturnType<typeof buildSaveDoc>) =>
  call<{ id: string; batch_no: number; pis_learned: number; pis_left_out: number; lines_learned: number }>(() => s.rpc('pricing_learning_save', { p_doc: doc }))

export const sendFeedback = (s: Supabase, doc: FeedbackDoc) => call<string>(() => s.rpc('pricing_feedback_add', { p_doc: doc }))
export const fetchFeedback = (s: Supabase, openOnly: boolean) => call<FeedbackRow[]>(() => s.rpc('pricing_feedback_list', { p_open_only: openOnly }))
export const setFeedbackStatus = (s: Supabase, id: string, status: FeedbackRow['status'], note: string | null) =>
  call<null>(() => s.rpc('pricing_feedback_set', { p_id: id, p_status: status, p_note: note }))
