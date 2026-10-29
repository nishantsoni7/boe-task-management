// The Payment plan PDF response, shared by the Order route and the BDPI route.
// Node only (pdfkit). Takes the answer of order_payment_plan_read or
// bdpi_payment_plan_read — the same shape — read AS THE CALLER by the route.

import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  computePaymentPlan,
  inputFromData,
  parsePlanData,
  plannedLotOf,
  plannedQuantities,
} from './paymentPlan'
import { buildPaymentPlanSheet, paymentPlanFileName } from './paymentPlanSheet'
import { renderPaymentPlanPdf } from './paymentPlanPdf'

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

async function readLogo(): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(process.cwd(), 'public', 'branding', 'boe-one-logo-horizontal.png')))
  } catch {
    return null
  }
}

export async function paymentPlanPdfResponse(read: { data: unknown; error: { code?: string; message: string } | null }) {
  if (read.error) {
    const forbidden = read.error.code === '42501' || /PAYMENT_PLAN_FORBIDDEN/.test(read.error.message)
    return forbidden
      ? fail(403, 'FORBIDDEN', 'You do not have access to the Payment plan.')
      : fail(500, 'PLAN_UNREADABLE', 'The Payment plan could not be read. Please try again.')
  }
  const plan = parsePlanData(read.data)
  if (!plan) return fail(404, 'NOT_FOUND', 'There is no PI to plan against.')

  const planned = plannedQuantities(plan.lots)
  const result = computePaymentPlan(inputFromData(plan, {
    planned,
    pendingPercent: plan.pendingPercent,
    billingPercentOverride: plan.billingPercentOverride,
    advanceAccountOverride: plan.advanceAccountOverride,
    advanceCashOverride: plan.advanceCashOverride,
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
