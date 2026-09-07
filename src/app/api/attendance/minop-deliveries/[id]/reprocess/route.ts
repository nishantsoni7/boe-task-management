import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { runMinopAttendanceProcessing } from '@/lib/minop/runProcessing'

/**
 * Admin "retry processing" (Phase G): re-run attendance processing for one
 * already-stored Minop delivery, typically after an unmapped employee code
 * has been given a fingerprint_employee_code.
 *
 * Admin-only. Reprocessing is safe to repeat because the merge it runs
 * (src/lib/minop/attendanceMerge.ts) is itself idempotent — replaying the
 * same punch can only ever reproduce the same earliest-in/latest-out result,
 * never post it twice. This route does not bypass the payroll-lock check: a
 * delivery for a now-locked month is refused exactly as it would be on first
 * receipt.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth
  const svc = auth.svc

  const { id } = await params

  const { data: delivery, error: fetchErr } = await svc
    .from('minop_webhook_deliveries')
    .select('id, payload, processing_status')
    .eq('id', id)
    .maybeSingle()

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!delivery) return NextResponse.json({ error: 'Delivery not found' }, { status: 404 })
  if (delivery.processing_status !== 'received') {
    return NextResponse.json(
      { error: 'This delivery was quarantined at receipt and was never a valid callback to process.' },
      { status: 422 },
    )
  }

  let outcome
  try {
    const result = await runMinopAttendanceProcessing(svc, { id: delivery.id, payload: delivery.payload })
    outcome = result.outcome

    const { error: updateErr } = await svc
      .from('minop_webhook_deliveries')
      .update(result.deliveryUpdate)
      .eq('id', delivery.id)
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Reprocessing failed: ${message}` }, { status: 500 })
  }

  return NextResponse.json({ outcome })
}
