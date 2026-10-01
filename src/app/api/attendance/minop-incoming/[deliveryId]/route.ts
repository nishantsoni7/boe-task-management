import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isResponse } from '@/lib/security/attendancePayrollApiAuth'
import { redactRawBody } from '@/lib/minop/incomingRegister'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Admin-only, read-only: one stored message with its full received body (credentials removed). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ deliveryId: string }> }) {
  const auth = await requireAdmin(req)
  if (isResponse(auth)) return auth

  const { deliveryId } = await params
  if (!UUID.test(deliveryId)) return NextResponse.json({ error: 'Message not found' }, { status: 404 })

  const { data, error } = await auth.svc
    .from('minop_webhook_deliveries')
    .select('id, received_at, service_tag_id, content_type, user_agent, auth_method, processing_status, error_text, body_sha256, raw_body')
    .eq('id', deliveryId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Message not found' }, { status: 404 })

  const { raw_body, ...meta } = data
  return NextResponse.json({ ...meta, raw_body: redactRawBody(String(raw_body)) }, { headers: { 'Cache-Control': 'no-store' } })
}
