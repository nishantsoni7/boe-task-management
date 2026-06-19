// GET  /api/payroll/adjustments?year=&month=&employee_id=
// POST /api/payroll/adjustments
// Admin only.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

async function getAdminCaller(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: { user }, error } = await svc.auth.getUser(token)
  if (error || !user) return null
  const { data: profile } = await svc.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return null
  return { svc, callerId: user.id }
}

export async function GET(req: NextRequest) {
  const ctx = await getAdminCaller(req)
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const yearParam  = req.nextUrl.searchParams.get('year')
  const monthParam = req.nextUrl.searchParams.get('month')
  const empId      = req.nextUrl.searchParams.get('employee_id')

  if (!yearParam || !monthParam || !empId)
    return NextResponse.json({ error: 'year, month, and employee_id are required' }, { status: 400 })

  const year  = parseInt(yearParam,  10)
  const month = parseInt(monthParam, 10)

  const { data, error } = await ctx.svc
    .from('payroll_pending_adjustments')
    .select('id, adjustment_type, amount, description, created_by, created_at')
    .eq('employee_id', empId)
    .eq('payroll_year',  year)
    .eq('payroll_month', month)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ adjustments: data ?? [] })
}

export async function POST(req: NextRequest) {
  const ctx = await getAdminCaller(req)
  if (!ctx) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: {
    employee_id:     string
    year:            number
    month:           number
    adjustment_type: 'addition' | 'deduction'
    amount:          number
    note:            string
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { employee_id, year, month, adjustment_type, amount, note } = body

  if (!employee_id || !year || !month || !adjustment_type || amount == null || !note?.trim())
    return NextResponse.json({ error: 'employee_id, year, month, adjustment_type, amount, and note are required' }, { status: 400 })

  if (!['addition', 'deduction'].includes(adjustment_type))
    return NextResponse.json({ error: 'adjustment_type must be addition or deduction' }, { status: 400 })

  if (typeof amount !== 'number' || amount <= 0)
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })

  const { data, error } = await ctx.svc
    .from('payroll_pending_adjustments')
    .insert({
      employee_id,
      payroll_year:    year,
      payroll_month:   month,
      adjustment_type,
      amount,
      description:     note.trim(),
      status:          'pending',
      created_by:      ctx.callerId,
    })
    .select('id, adjustment_type, amount, description, created_by, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ adjustment: data }, { status: 201 })
}
