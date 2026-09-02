// The salary-processing report — what an admin sends when paying a month.
//
// WHAT THIS IS AND IS NOT
// -----------------------
// It is a summary of STORED payroll figures for a chosen set of employees, in a
// form that can be read in a message. Every number on it comes from
// payroll_results and payroll_pending_adjustments as they were written by
// generation. Nothing here recalculates a salary, and nothing here may: a report
// that computed its own figures would eventually disagree with the payslip it
// claims to summarise, and the disagreement would surface as an employee being
// paid one number and shown another.
//
// WHAT IS DELIBERATELY ABSENT
// ---------------------------
// No punches, no objections, no comments, no correction remarks, no internal
// notes, no settings. This text gets pasted into WhatsApp, so everything on it
// should be something the company is content to have leave the system. An
// adjustment's free-text `description` is deliberately NOT included either —
// admins write things like "advance for medical, see chat" in it. The CATEGORY
// is what the report states, which is the reason categories exist.
//
// ROUNDING
// --------
// Every figure is already a whole rupee when it arrives, because the engine
// rounds each line and totals the rounded lines. This module formats through the
// same helper rather than trusting that, so a legacy row carrying paise still
// renders as rupees instead of putting a decimal into a WhatsApp message.

import { formatRupees, roundRupees, sumRupees } from './money'
import {
  reportingCategory,
  ADJUSTMENT_CATEGORY_LABELS,
  REPORT_CATEGORY_ORDER,
  type AdjustmentCategory,
} from './adjustmentCategories'
import type { AdjustmentType } from './adjustments'
import { computeSettlement } from './settlement'

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** A stored payroll_results row, reduced to what the report states. */
export type ReportResultRow = {
  employee_id: string
  employee_name: string
  employee_code: string | null
  gross_salary: number | null
  total_deductions: number | null
  net_salary: number | null
  /**
   * The present-day count. NOT stated on the report — it is read only to apply
   * the absence floor, which is an attendance RULE and not an attendance figure.
   *
   * Required, nullable rather than optional: a caller that omitted it would
   * silently take the absence floor and report ₹0 payable for everyone, which is
   * exactly the kind of wrong number that looks like a real one.
   *
   * `pending_adjustment_total` is deliberately NOT here. See buildSalaryReport.
   */
  days_present: number | null
}

/** A stored adjustment row, reduced likewise. Description is NOT carried. */
export type ReportAdjustmentRow = {
  employee_id: string
  adjustment_type: AdjustmentType
  adjustment_category: unknown
  amount: number
}

/**
 * A stored payroll_settlements row, reduced to the one figure the report needs.
 *
 * `amount_paid` is deliberately absent. The report states what is payable, never
 * what has been paid, so a payment amount has no reason to travel with a message
 * bound for WhatsApp — and Salary Payable does not depend on it.
 */
export type ReportSettlementRow = {
  employee_id: string
  carry_forward_amount: number | null
  /**
   * The rupee SNAPSHOT of the employee's active BOE Credits payroll
   * application (Phase 1D), or null/absent when there is none. Settlement
   * adds it to Salary Payable, so the report must too.
   */
  boe_credit_addition?: number | null
}

// ─── Output ───────────────────────────────────────────────────────────────────

export type ReportLine = {
  key: string
  label: string
  /** Signed: negative for a deduction, so the sign is in the data not the label. */
  amount: number
}

export type ReportEmployee = {
  employee_id: string
  employee_name: string
  employee_code: string | null
  gross_salary: number
  attendance_deduction: number
  /** Only the categories that actually carry an amount, in report order. */
  adjustment_lines: ReportLine[]
  net_payable: number
  /**
   * Gross minus the attendance deduction — what the Payroll Result Detail page
   * calls Salary After Attendance.
   */
  salary_to_be_booked: number
  /**
   * The saved advance/settlement figure, signed: negative when it is recovered.
   * The detail page's Net Adjustments — the carry-forward plus the adjustment
   * total the engine applied.
   */
  advance: number
  /** The BOE Credits salary addition (Phase 1D), from the stored snapshot. 0 when none. */
  boe_credit_addition: number
  /** salary_to_be_booked + advance + boe_credit_addition. The detail page's Salary Payable. */
  amount_payable: number
}

export type SalaryReport = {
  month: number
  year: number
  employees: ReportEmployee[]
  totals: {
    gross_salary: number
    attendance_deduction: number
    net_payable: number
    amount_payable: number
  }
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

function n(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? roundRupees(value) : 0
}

/**
 * Build the report for the SELECTED employees only.
 *
 * The selection is applied here, at assembly, rather than being trusted from the
 * caller's data: `results` may legitimately contain the whole period, and only
 * the named employees may appear in the output or in the totals. An id that is
 * selected but has no stored result is skipped rather than invented — there is
 * no payroll for that employee this month, and a report must not imply there is.
 *
 * `settlements` defaults to none, which computeSettlement reads exactly as the
 * detail page does: an employee-month with no stored settlement row has no
 * carry-forward.
 */
export function buildSalaryReport(
  month: number,
  year: number,
  results: ReportResultRow[],
  adjustments: ReportAdjustmentRow[],
  selectedEmployeeIds: readonly string[],
  settlements: ReportSettlementRow[] = [],
): SalaryReport {
  const selected = new Set(selectedEmployeeIds)
  const carryForwardByEmployee = new Map(
    settlements.map(s => [s.employee_id, n(s.carry_forward_amount)]),
  )
  const creditAdditionByEmployee = new Map(
    settlements.map(s => [s.employee_id, n(s.boe_credit_addition ?? null)]),
  )

  // Adjustments grouped by employee then by REPORTING category, so an
  // uncategorised legacy row lands on the matching Other line rather than being
  // dropped or guessed at.
  const byEmployee = new Map<string, Map<AdjustmentCategory, number[]>>()
  for (const adj of adjustments) {
    if (!selected.has(adj.employee_id)) continue
    const category = reportingCategory(adj.adjustment_category, adj.adjustment_type)
    const forEmployee = byEmployee.get(adj.employee_id) ?? new Map<AdjustmentCategory, number[]>()
    const amounts = forEmployee.get(category) ?? []
    // Stored positive with the direction in adjustment_type; the report shows a
    // deduction as negative so a reader never has to know that convention.
    amounts.push(adj.adjustment_type === 'deduction' ? -Math.abs(n(adj.amount)) : Math.abs(n(adj.amount)))
    forEmployee.set(category, amounts)
    byEmployee.set(adj.employee_id, forEmployee)
  }

  const employees: ReportEmployee[] = []
  for (const row of results) {
    if (!selected.has(row.employee_id)) continue

    const categories = byEmployee.get(row.employee_id)
    const adjustment_lines: ReportLine[] = []
    for (const category of REPORT_CATEGORY_ORDER) {
      const amounts = categories?.get(category)
      if (!amounts || amounts.length === 0) continue
      const amount = sumRupees(amounts)
      // A category whose entries cancel to zero is omitted: the report lists
      // what was paid or recovered, and ₹0 is neither.
      if (amount === 0) continue
      adjustment_lines.push({
        key: category,
        label: ADJUSTMENT_CATEGORY_LABELS[category],
        amount,
      })
    }

    // The adjustment total is the sum of the lines THIS REPORT ITEMISES, and
    // that is the fix for a live defect rather than a stylistic choice.
    //
    // It used to be `payroll_results.pending_adjustment_total`. That column is
    // written only by the payroll ENGINE, at generation time. An advance saved
    // afterwards — which is the normal way admins record one, since
    // POST /api/payroll/adjustments inserts a `pending` row and never touches
    // the column — left it stale at 0. The report then itemised the ₹3,433
    // advance in Preview while the summary said Advance ₹0 and paid the
    // employee the full salary: one report, two adjustment sources, disagreeing
    // about money.
    //
    // Reading the itemised lines instead makes the summary agree with the
    // document it summarises BY CONSTRUCTION, and picks up a saved advance
    // whether or not the period has since been regenerated.
    //
    // Still exactly one calculation: computeSettlement, the same function the
    // Payroll Result Detail page reaches its figures through. Only the input it
    // is given changed — Salary to be Booked, Advance and Amount Payable remain
    // that page's Salary After Attendance, Net Adjustments and Salary Payable.
    //
    // The inputs are rounded on the way IN so the arithmetic runs on whole
    // rupees and the printed lines add up to the printed total. A legacy row
    // carrying paise would otherwise round the figures independently and show a
    // subtraction that is a rupee out.
    //
    // `amount_paid` is passed as null on purpose: Salary Payable does not depend
    // on it, and what was paid is not this report's business.
    const adjustmentsTotal = sumRupees(adjustment_lines.map(line => line.amount))

    const figures = computeSettlement(
      {
        gross_salary:             n(row.gross_salary),
        total_deductions:         n(row.total_deductions),
        pending_adjustment_total: adjustmentsTotal,
        days_present:             row.days_present,
      },
      {
        carry_forward_amount: carryForwardByEmployee.get(row.employee_id) ?? 0,
        amount_paid:          null,
      },
      // The stored snapshot, never re-derived: the same third input the
      // payslip's settlement block is given.
      (creditAdditionByEmployee.get(row.employee_id) ?? 0) > 0
        ? { credits_used: 0, credit_value_snapshot: 0, credit_amount_snapshot: creditAdditionByEmployee.get(row.employee_id) ?? 0 }
        : null,
    )

    employees.push({
      employee_id:   row.employee_id,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      gross_salary:         n(row.gross_salary),
      attendance_deduction: n(row.total_deductions),
      adjustment_lines,
      // The STORED net, not a re-derivation. If this recomputed
      // gross − deductions + adjustments it would drift from the payslip the
      // moment either changed for a reason this module does not model.
      net_payable: n(row.net_salary),
      salary_to_be_booked: figures.salary_after_attendance,
      advance:             figures.net_adjustments,
      boe_credit_addition: figures.boe_credit_addition,
      amount_payable:      figures.salary_payable,
    })
  }

  return {
    month,
    year,
    employees,
    totals: {
      gross_salary:         sumRupees(employees.map(e => e.gross_salary)),
      attendance_deduction: sumRupees(employees.map(e => e.attendance_deduction)),
      net_payable:          sumRupees(employees.map(e => e.net_payable)),
      amount_payable:       sumRupees(employees.map(e => e.amount_payable)),
    },
  }
}

// ─── Text rendering ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function monthLabel(month: number, year: number): string {
  return `${MONTH_NAMES[month - 1] ?? String(month)} ${year}`
}

/**
 * The full report, for Preview and for Copy.
 *
 * Preview and Copy must be the SAME string — an admin who checks the preview and
 * then pastes something different has been shown a different document from the
 * one they sent. So there is one renderer and both call it.
 */
export function renderReportText(report: SalaryReport): string {
  const lines: string[] = []
  lines.push(`Salary — ${monthLabel(report.month, report.year)}`)
  lines.push('')

  for (const e of report.employees) {
    lines.push(e.employee_name)
    lines.push(`  Salary: ${formatRupees(e.gross_salary)}`)
    if (e.attendance_deduction !== 0) {
      lines.push(`  Attendance deduction: -${formatRupees(e.attendance_deduction)}`)
    }
    for (const line of e.adjustment_lines) {
      const sign = line.amount < 0 ? '-' : '+'
      lines.push(`  ${line.label}: ${sign}${formatRupees(Math.abs(line.amount))}`)
    }
    lines.push(`  Net payable: ${formatRupees(e.net_payable)}`)
    // The BOE Credits addition (Phase 1D) sits outside net_salary by design —
    // it is a Settlement line — so it is printed after it, with the payable
    // it produces, whenever one applies.
    if (e.boe_credit_addition !== 0) {
      lines.push(`  BOE Credits: +${formatRupees(e.boe_credit_addition)}`)
      lines.push(`  Amount payable: ${formatRupees(e.amount_payable)}`)
    }
    lines.push('')
  }

  lines.push(`Employees: ${report.employees.length}`)
  lines.push(`Total net payable: ${formatRupees(report.totals.net_payable)}`)

  return lines.join('\n')
}

/**
 * A signed amount with the direction in the text, e.g. "-₹3,433" / "+₹1,200".
 *
 * A bare ₹0 for a figure that is genuinely nothing: printing "-₹0" reads as a
 * deduction that was applied and happened to be nil.
 */
function signedRupees(amount: number): string {
  const whole = roundRupees(amount)
  if (whole === 0) return formatRupees(0)
  return `${whole < 0 ? '-' : '+'}${formatRupees(Math.abs(whole))}`
}

/**
 * The salary summary for WhatsApp: what is being booked, and what is being paid.
 *
 * WHAT IT STATES, AND WHY ONLY THIS
 * ---------------------------------
 * Always the employee's name and Salary to be Booked. Advance and Amount
 * Payable appear only when a non-zero advance actually applies — for most
 * employees, most months, the salary booked IS the amount payable, and printing
 * "Advance: ₹0 / Amount Payable: <the same number again>" invites the reader to
 * hunt for a deduction that does not exist.
 *
 * Gross Salary and Attendance Deduction are deliberately absent: the message
 * answers "what is being paid", and the workings behind the booked figure are a
 * payslip question. No present, absent, half or paid day counts either, and no
 * itemisation of what an advance was for. The full detail stays available
 * through Preview and Copy — nothing is hidden, it is carried by a different
 * channel.
 *
 * Every figure comes from buildSalaryReport, through the same computeSettlement
 * the Payroll Result Detail page uses: Salary to be Booked is that page's Salary
 * After Attendance, Advance its Net Adjustments, Amount Payable its Salary
 * Payable.
 *
 * SIGNS. `advance` is already signed — negative when money is being recovered.
 * So Amount Payable is salary + advance, an ADDITION, and it is computed once by
 * computeSettlement rather than re-derived here. Subtracting an already-negative
 * advance would turn a ₹3,433 recovery into a ₹3,433 bonus, and the result would
 * still look like a plausible payslip.
 */
export function renderWhatsAppText(report: SalaryReport): string {
  const lines: string[] = []
  lines.push(`Salary — ${monthLabel(report.month, report.year)}`)
  for (const e of report.employees) {
    lines.push('')
    lines.push(e.employee_name)
    lines.push(`Salary to be Booked: ${formatRupees(e.salary_to_be_booked)}`)
    // Whole rupees throughout, so an exact zero test is the right one: there is
    // no such thing here as an advance of half a rupee that this would miss.
    if (e.advance !== 0) {
      lines.push(`Advance: ${signedRupees(e.advance)}`)
    }
    // The BOE Credits addition (Phase 1D), from the stored snapshot. Like the
    // advance, it appears only when it applies, and it changes what is payable.
    if (e.boe_credit_addition !== 0) {
      lines.push(`BOE Credits: +${formatRupees(e.boe_credit_addition)}`)
    }
    if (e.advance !== 0 || e.boe_credit_addition !== 0) {
      lines.push(`Amount Payable: ${formatRupees(e.amount_payable)}`)
    }
  }
  lines.push('')
  // The total of what is actually payable, which for an employee with no advance
  // is their booked salary. Totalling net_salary here — clamped at ₹0 and
  // carrying no advance — would put a footer on the message that its own lines
  // do not add up to.
  lines.push(`Total: ${formatRupees(report.totals.amount_payable)} (${report.employees.length})`)
  return lines.join('\n')
}

// ─── WhatsApp length ──────────────────────────────────────────────────────────

/**
 * The most ENCODED characters we will put in a wa.me URL.
 *
 * Conservative on purpose. WhatsApp itself accepts far longer messages, but the
 * text travels as a percent-encoded query parameter, and the practical ceiling
 * is imposed by whatever browser, webview and OS handoff the link passes
 * through — several of which truncate a long URL silently rather than failing.
 *
 * Silent truncation is the specific outcome worth engineering against: a report
 * that loses its last three employees still LOOKS like a complete report to
 * whoever receives it. So the limit is checked before the link is built, it is
 * measured on the ENCODED length (a single ₹ or newline costs three characters
 * once encoded, so counting the raw string would badly under-estimate), and the
 * admin is asked to select fewer employees rather than being handed a cut-off
 * message.
 *
 * 1,800 leaves comfortable headroom under the ~2,000 that the narrowest common
 * handoffs tolerate.
 */
export const WHATSAPP_URL_TEXT_LIMIT = 1_800

export type WhatsAppPreparation =
  | { ok: true;  text: string; encodedLength: number; url: string }
  | { ok: false; text: string; encodedLength: number; limit: number; message: string }

/**
 * Prepare the WhatsApp handoff, or explain why it cannot be made.
 *
 * Never truncates, and never returns a URL it knows is too long. The failure
 * carries the text and the counts so the page can keep Preview and Copy working
 * — the report is not lost, only this one channel is unavailable for it.
 */
export function prepareWhatsApp(report: SalaryReport): WhatsAppPreparation {
  const text = renderWhatsAppText(report)
  const encoded = encodeURIComponent(text)
  const encodedLength = encoded.length

  if (encodedLength > WHATSAPP_URL_TEXT_LIMIT) {
    return {
      ok: false,
      text,
      encodedLength,
      limit: WHATSAPP_URL_TEXT_LIMIT,
      message:
        `This report is too long to send through WhatsApp as a link ` +
        `(${encodedLength.toLocaleString('en-IN')} of ${WHATSAPP_URL_TEXT_LIMIT.toLocaleString('en-IN')} characters). ` +
        `Select fewer employees, or use Copy and paste it into WhatsApp yourself.`,
    }
  }

  return {
    ok: true,
    text,
    encodedLength,
    // wa.me with no number: WhatsApp asks the sender who to send it to, so the
    // report is never addressed to a recipient this code chose.
    url: `https://wa.me/?text=${encoded}`,
  }
}
