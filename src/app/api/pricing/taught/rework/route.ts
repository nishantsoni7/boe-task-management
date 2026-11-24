import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminClient } from '@/lib/supabase/admin'
import { learnedWeight, rateBook, rework, type LearnedWeight, type ReworkCase, type Reworked, type SavedRow } from '@/lib/pricing/training/rework'

// Price Brain v2, phase 2: the taught price of a picked case, worked out again for each quotation line (its size, its
// wood, today's rates). It runs here, on the server, because working it out needs the case's rows, rates and margins,
// and a person who may only quote must get the price alone (owner default, 16 Nov 2026: salespeople see the taught
// price, its photo and its name; what it is made of stays with Pricing). People who may open Pricing also get the rows
// and what changed. The caller must be signed in and able to open Quotations or Pricing. Nothing is written.

export const runtime = 'nodejs'

const MAX_LINES = 60
type Ask = { key: string; caseNo: number; size: string | null; wood: string | null }
export type ReworkAnswer = { key: string } & Pick<Reworked, 'caseNo' | 'taught' | 'price' | 'sized' | 'wood'> & Partial<Pick<Reworked, 'rows' | 'changes'>>
type Reply = { ok: true; results: ReworkAnswer[] } | { ok: false; error: string }
const reply = (body: Reply, status = 200) => NextResponse.json(body, { status })

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

export async function POST(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!token || !url || !anon) return reply({ ok: false, error: 'Sign in again.' }, 401)
  const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: who, error: whoErr } = await asUser.auth.getUser(token)
  if (whoErr || !who.user) return reply({ ok: false, error: 'Sign in again.' }, 401)
  // Each access function refuses a person the module is not open to; one of the two must answer.
  const [quotes, pricing] = await Promise.all([asUser.rpc('quotation_my_access'), asUser.rpc('pricing_training_access')])
  const sees = !pricing.error
  if (quotes.error && !sees) return reply({ ok: false, error: 'Neither Quotations nor Pricing is open to you.' }, 403)

  const body = await req.json().catch(() => null) as { lines?: unknown } | null
  const asks: Ask[] = (Array.isArray(body?.lines) ? body!.lines : []).slice(0, MAX_LINES).flatMap((x): Ask[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const key = text(o.key, 80)
    const caseNo = typeof o.caseNo === 'number' && Number.isInteger(o.caseNo) && o.caseNo > 0 ? o.caseNo : null
    return key && caseNo ? [{ key, caseNo, size: text(o.size, 160), wood: text(o.wood, 40) }] : []
  })
  if (asks.length === 0) return reply({ ok: true, results: [] })

  const admin = adminClient()
  if (!admin.ok) {
    console.error('taught rework: server credential missing', admin.missing)
    return reply({ ok: false, error: 'Working out a taught price is not set up on the server yet.' }, 503)
  }
  const db = admin.client
  const caseNos = [...new Set(asks.map(a => a.caseNo))]
  const cases = await db.from('pricing_training_cases').select('id, case_no, name, width_in, depth_in, height_in, per_set').eq('status', 'submitted').in('case_no', caseNos)
  if (cases.error) { console.error('taught rework: cases', cases.error.code); return reply({ ok: false, error: 'The taught cases could not be read. Try again.' }, 502) }
  const ids = (cases.data ?? []).map(c => c.id as string)
  const [rows, woods, metals] = await Promise.all([
    ids.length ? db.from('pricing_training_lines').select('case_id, position, element, kind, material, quantity, unit, rate, amount, wood_amount, calc').in('case_id', ids).order('position') : Promise.resolve({ data: [], error: null }),
    db.from('pricing_woods').select('name, rate'),
    db.from('pricing_metals').select('name, rate'),
  ])
  if (rows.error || woods.error || metals.error) { console.error('taught rework: rows or rates'); return reply({ ok: false, error: 'The taught cases could not be read. Try again.' }, 502) }

  const book = rateBook(woods.data ?? [], metals.data ?? [])
  // Weighed frames, step two: what the scale usually says against the calculator, from the metal frames that were weighed.
  // Asked only when a picked case has a metal frame, and best effort: a failed read prices the frame as taught.
  let learned: LearnedWeight | null = null
  if ((rows.data ?? []).some(r => (r.calc as { type?: string } | null)?.type === 'metal')) {
    const weighed = await db.from('pricing_training_lines').select('calc, pricing_training_cases!inner(status)')
      .eq('pricing_training_cases.status', 'submitted').eq('calc->>type', 'metal').not('calc->>weighed_kg', 'is', null).limit(500)
    if (weighed.error) console.error('taught rework: weighed frames', weighed.error.code)
    else learned = learnedWeight((weighed.data ?? []).map(r => r.calc))
  }
  const byNo = new Map<number, ReworkCase>((cases.data ?? []).map(c => [Number(c.case_no), {
    case_no: Number(c.case_no), name: String(c.name), per_set: c.per_set === null ? null : Number(c.per_set),
    width_in: c.width_in === null ? null : Number(c.width_in), depth_in: c.depth_in === null ? null : Number(c.depth_in), height_in: c.height_in === null ? null : Number(c.height_in),
    rows: ((rows.data ?? []) as (SavedRow & { case_id: string })[]).filter(r => r.case_id === c.id).map(r => ({ ...r, amount: Number(r.amount) })),
  }]))

  const results = asks.flatMap((a): ReworkAnswer[] => {
    const c = byNo.get(a.caseNo)
    if (!c) return []
    const w = rework(c, { size: a.size, wood: a.wood }, book, learned)
    const base = { key: a.key, caseNo: w.caseNo, taught: w.taught, price: w.price, sized: w.sized, wood: w.wood }
    return [sees ? { ...base, rows: w.rows, changes: w.changes } : base]
  })
  return reply({ ok: true, results })
}
