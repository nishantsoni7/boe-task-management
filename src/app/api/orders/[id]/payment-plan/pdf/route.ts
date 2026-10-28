import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/orders/submissionPayload'
import {
  computePaymentPlan,
  inputFromData,
  parsePlanData,
  plannedLotOf,
  plannedQuantities,
} from '@/lib/orders/paymentPlan'
import { buildPaymentPlanSheet, paymentPlanFileName } from '@/lib/orders/paymentPlanSheet'
import { renderPaymentPlanPdf } from '@/lib/orders/paymentPlanPdf'

// ── THE PAYMENT PLAN AS A PDF ────────────────────────────────────────────────
//
// GET /api/orders/{orderId}/payment-plan/pdf
//
// Draws the SAVED plan (the Order page asks the person to save before it offers
// the download). Everything is read as the caller through order_payment_plan_read,
// which asks the database for the Orders entry gate, view_payment_plan and the
// right to open the Order; no service role is involved. Nothing is stored.

export const runtime = 'nodejs'

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

async function readLogo(): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(process.cwd(), 'public', 'branding', 'boe-one-logo-horizontal.png')))
  } catch {
    return null
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: orderId } = await params
  if (!isUuid(orderId)) return fail(400, 'BAD_REQUEST', 'A valid Order is required.')

  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Please sign in again.')

  const { data, error } = await authClient.rpc('order_payment_plan_read', { p_order_id: orderId })
  if (error) {
    const forbidden = error.code === '42501' || /PAYMENT_PLAN_FORBIDDEN/.test(error.message)
    return forbidden
      ? fail(403, 'FORBIDDEN', 'You do not have access to the Payment plan.')
      : fail(500, 'PLAN_UNREADABLE', 'The Payment plan could not be read. Please try again.')
  }
  const plan = parsePlanData(data)
  if (!plan) return fail(404, 'NOT_FOUND', 'This Order has no PI to plan against.')

  const planned = plannedQuantities(plan.lots)
  const result = computePaymentPlan(inputFromData(plan, {
    planned,
    pendingPercent: plan.pendingPercent,
    billingPercentOverride: plan.billingPercentOverride,
    advanceOverride: plan.advanceOverride,
  }))
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-')
  const sheet = buildPaymentPlanSheet(plan, result, {
    lotLines: planned,
    generatedOn: today,
    plannedOn: plannedLotOf(plan.lots)?.plannedOn ?? null,
  })
  const pdf = await renderPaymentPlanPdf(sheet, await readLogo())
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${paymentPlanFileName(plan.displayNumber, 'pdf')}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
