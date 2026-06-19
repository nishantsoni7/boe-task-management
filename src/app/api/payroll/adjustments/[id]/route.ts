// DELETE /api/payroll/adjustments/[id]
// Admin only. Only deletes adjustments with status='pending'.

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error: authErr } = await svc.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await svc.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params

  // Verify it exists and is still pending
  const { data: existing } = await svc
    .from('payroll_pending_adjustments')
    .select('id, status')
    .eq('id', id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Adjustment not found' }, { status: 404 })
  if (existing.status !== 'pending')
    return NextResponse.json({ error: 'Only pending adjustments can be deleted' }, { status: 409 })

  const { error } = await svc
    .from('payroll_pending_adjustments')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
