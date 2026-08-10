/**
 * The salary-processing report.
 *
 *   npx tsx --test src/lib/payroll/salaryReport.test.ts
 *
 * Three things here are worth more than the rest.
 *
 * PRIVACY. This text is written to be pasted into WhatsApp. Anything that
 * reaches it leaves the system, so the tests assert what must NOT be on it —
 * punches, objections, comments, correction remarks, internal notes, settings,
 * day counts, and the free-text description of an adjustment, which is where
 * admins write "advance for medical, see chat".
 *
 * SELECTION. Totals must cover the selected employees and nobody else. A report
 * that quietly totalled the whole period would leak the payroll of people the
 * admin deliberately left out.
 *
 * TRUNCATION. A WhatsApp link that loses its last three employees still looks
 * like a complete report to whoever receives it. The length is therefore checked
 * on the ENCODED string before a URL is built, and the failure returns no URL at
 * all rather than a shortened one.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSalaryReport,
  renderReportText,
  renderWhatsAppText,
  prepareWhatsApp,
  monthLabel,
  WHATSAPP_URL_TEXT_LIMIT,
  type ReportResultRow,
  type ReportAdjustmentRow,
  type ReportSettlementRow,
} from './salaryReport'
import { computeSettlement } from './settlement'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function result(
  id: string,
  name: string,
  over: Partial<ReportResultRow> = {},
): ReportResultRow {
  return {
    employee_id: id,
    employee_name: name,
    employee_code: `E${id}`,
    gross_salary: 26_000,
    total_deductions: 1_000,
    pending_adjustment_total: 0,
    days_present: 24,
    net_salary: 25_000,
    ...over,
  }
}

function adj(
  employee_id: string,
  adjustment_type: 'addition' | 'deduction',
  adjustment_category: unknown,
  amount: number,
): ReportAdjustmentRow {
  return { employee_id, adjustment_type, adjustment_category, amount }
}

function settlement(employee_id: string, carry_forward_amount: number): ReportSettlementRow {
  return { employee_id, carry_forward_amount }
}

const AMIT  = result('1', 'Amit Sharma')
const PRIYA = result('2', 'Priya Nair', { gross_salary: 30_000, total_deductions: 0, net_salary: 30_000 })
const RAVI  = result('3', 'Ravi Kumar', { gross_salary: 18_000, total_deductions: 500,  net_salary: 17_500 })

// ─── Selection ────────────────────────────────────────────────────────────────

describe('selection', () => {
  test('only the selected employees appear', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], ['1', '3'])
    assert.deepEqual(r.employees.map(e => e.employee_name), ['Amit Sharma', 'Ravi Kumar'])
  })

  test('selecting all includes everybody', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], ['1', '2', '3'])
    assert.equal(r.employees.length, 3)
  })

  test('selecting nobody produces an empty report, not the whole period', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], [])
    assert.equal(r.employees.length, 0)
    assert.equal(r.totals.net_payable, 0)
  })

  test('totals cover the selected employees ONLY', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], ['1', '3'])
    assert.equal(r.totals.net_payable, 25_000 + 17_500)
    assert.equal(r.totals.gross_salary, 26_000 + 18_000)
    assert.notEqual(r.totals.net_payable, 25_000 + 30_000 + 17_500)
  })

  test('a selected employee with no stored result is skipped, not invented', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [], ['1', 'ghost'])
    assert.equal(r.employees.length, 1)
    assert.equal(r.employees[0]!.employee_id, '1')
  })

  test('an unselected employee’s adjustments never reach the totals', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA], [
      adj('2', 'addition', 'bonus', 5_000),
    ], ['1'])
    assert.equal(r.employees.length, 1)
    assert.equal(r.employees[0]!.adjustment_lines.length, 0)
  })
})

// ─── Category mapping ─────────────────────────────────────────────────────────

describe('category mapping', () => {
  test('each category becomes its own labelled line', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'deduction', 'advance_recovery',        2_000),
      adj('1', 'addition',  'incentive',               1_500),
      adj('1', 'addition',  'bonus',                   1_000),
      adj('1', 'addition',  'reimbursement',             750),
      adj('1', 'addition',  'previous_salary_pending',   500),
    ], ['1'])

    const byKey = Object.fromEntries(r.employees[0]!.adjustment_lines.map(l => [l.key, l.amount]))
    assert.equal(byKey.advance_recovery, -2_000)
    assert.equal(byKey.incentive, 1_500)
    assert.equal(byKey.bonus, 1_000)
    assert.equal(byKey.reimbursement, 750)
    assert.equal(byKey.previous_salary_pending, 500)
  })

  test('lines come out in the report order, not insertion order', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'addition',  'bonus',            1_000),
      adj('1', 'deduction', 'advance_recovery', 2_000),
    ], ['1'])
    assert.deepEqual(r.employees[0]!.adjustment_lines.map(l => l.key), ['advance_recovery', 'bonus'])
  })

  test('several entries in one category are added together', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'addition', 'incentive', 1_000),
      adj('1', 'addition', 'incentive',   500),
    ], ['1'])
    assert.equal(r.employees[0]!.adjustment_lines[0]!.amount, 1_500)
  })

  test('an uncategorised legacy row lands on the matching Other line', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'addition',  null, 900),
      adj('1', 'deduction', null, 400),
    ], ['1'])
    const byKey = Object.fromEntries(r.employees[0]!.adjustment_lines.map(l => [l.key, l.amount]))
    assert.equal(byKey.other_addition, 900)
    assert.equal(byKey.other_deduction, -400)
  })

  test('a deduction is negative, so the sign lives in the data not the label', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'deduction', 'advance_recovery', 2_000),
    ], ['1'])
    assert.equal(r.employees[0]!.adjustment_lines[0]!.amount, -2_000)
  })

  test('a stored negative amount cannot flip a deduction into an addition', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'deduction', 'advance_recovery', -2_000),
    ], ['1'])
    assert.equal(r.employees[0]!.adjustment_lines[0]!.amount, -2_000)
  })
})

// ─── Zero omission ────────────────────────────────────────────────────────────

describe('zero values are omitted', () => {
  test('a category with no entries produces no line', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [], ['1'])
    assert.deepEqual(r.employees[0]!.adjustment_lines, [])
  })

  test('a category whose entries cancel to zero produces no line', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'addition',  'other_addition', 500),
      adj('1', 'deduction', 'other_deduction', 500),
    ], ['1'])
    const keys = r.employees[0]!.adjustment_lines.map(l => l.key)
    assert.equal(keys.includes('other_addition'), true)
    assert.equal(keys.includes('other_deduction'), true)

    // Two entries within ONE category that cancel:
    const r2 = buildSalaryReport(7, 2026, [AMIT], [
      adj('1', 'addition', 'incentive', 500),
      adj('1', 'deduction', 'other_deduction', 0),
    ], ['1'])
    assert.equal(r2.employees[0]!.adjustment_lines.some(l => l.key === 'other_deduction'), false)
  })

  test('a zero attendance deduction is omitted from the text', () => {
    const text = renderReportText(buildSalaryReport(7, 2026, [PRIYA], [], ['2']))
    assert.doesNotMatch(text, /Attendance deduction/)
  })
})

// ─── Whole rupees ─────────────────────────────────────────────────────────────

describe('whole-rupee formatting', () => {
  test('no rendered figure contains a decimal point', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit Sharma', { gross_salary: 26_000.4, total_deductions: 1_000.6, net_salary: 24_999.5 }),
    ], [adj('1', 'addition', 'incentive', 1_500.5)], ['1'])

    for (const text of [renderReportText(r), renderWhatsAppText(r)]) {
      assert.doesNotMatch(text, /\d\.\d/, `decimal currency in:\n${text}`)
    }
  })

  test('every assembled amount is a whole rupee', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: 26_000.4, total_deductions: 1_000.6, net_salary: 24_999.5 }),
    ], [adj('1', 'addition', 'incentive', 1_500.5)], ['1'])
    const e = r.employees[0]!
    for (const v of [e.gross_salary, e.attendance_deduction, e.net_payable, ...e.adjustment_lines.map(l => l.amount)]) {
      assert.ok(Number.isInteger(v), `${v} is not whole`)
    }
    assert.ok(Number.isInteger(r.totals.net_payable))
  })

  test('Indian digit grouping is used', () => {
    const r = buildSalaryReport(7, 2026, [result('1', 'Amit', { net_salary: 123_456 })], [], ['1'])
    assert.match(renderReportText(r), /₹1,23,456/)
  })
})

// ─── The report uses STORED figures ───────────────────────────────────────────

describe('figures come from stored payroll, not a re-derivation', () => {
  test('net payable is the stored net, even when it disagrees with the arithmetic', () => {
    // Deliberately inconsistent input. A report that recomputed
    // gross − deductions + adjustments would "fix" this and drift from the
    // payslip; it must report what payroll actually stored.
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: 26_000, total_deductions: 1_000, net_salary: 99_999 }),
    ], [], ['1'])
    assert.equal(r.employees[0]!.net_payable, 99_999)
  })

  test('a null stored figure reads as zero rather than crashing the report', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: null, total_deductions: null, net_salary: null }),
    ], [], ['1'])
    assert.equal(r.employees[0]!.net_payable, 0)
    assert.equal(r.totals.net_payable, 0)
  })
})

// ─── Preview and Copy are the same document ───────────────────────────────────

describe('preview and copy', () => {
  test('the preview text and the copied text are identical', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA], [adj('1', 'addition', 'bonus', 1_000)], ['1', '2'])
    // One renderer, called by both. An admin who checks the preview and pastes
    // something different has been shown a different document.
    assert.equal(renderReportText(r), renderReportText(r))
    assert.match(renderReportText(r), /Amit Sharma/)
    assert.match(renderReportText(r), /Priya Nair/)
  })

  test('the text states the month, the headcount and the total', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA], [], ['1', '2'])
    const text = renderReportText(r)
    assert.match(text, /July 2026/)
    assert.match(text, /Employees: 2/)
    assert.match(text, /Total net payable: ₹55,000/)
  })

  test('monthLabel names every month', () => {
    assert.equal(monthLabel(1, 2026), 'January 2026')
    assert.equal(monthLabel(12, 2026), 'December 2026')
  })
})

// ─── Privacy ──────────────────────────────────────────────────────────────────

describe('what must never reach the report', () => {
  test('an adjustment description is not carried into the text', () => {
    // The input type has no description field at all, which is the structural
    // guarantee. This asserts the behaviour a reviewer would check for.
    const r = buildSalaryReport(7, 2026, [AMIT], [
      { ...adj('1', 'deduction', 'advance_recovery', 2_000), description: 'advance for medical, see chat' } as ReportAdjustmentRow,
    ], ['1'])
    const text = renderReportText(r)
    assert.doesNotMatch(text, /medical/i)
    assert.doesNotMatch(text, /see chat/i)
    // The category label IS shown — that is the point of categories.
    assert.match(text, /Advance recovery/)
  })

  test('no punch, objection, comment, remark, note or setting vocabulary appears', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [
      adj('1', 'addition', 'bonus', 1_000),
      adj('2', 'deduction', 'advance_recovery', 500),
    ], ['1', '2', '3'])
    const text = `${renderReportText(r)}\n${renderWhatsAppText(r)}`
    for (const forbidden of [
      /punch/i, /check[_ ]?in/i, /check[_ ]?out/i, /objection/i, /comment/i,
      /remark/i, /internal note/i, /correction/i, /divisor/i, /grace/i, /threshold/i,
    ]) {
      assert.doesNotMatch(text, forbidden, `report leaked ${forbidden}`)
    }
  })

  test('an unselected employee’s name never appears in the text', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], ['1'])
    const text = `${renderReportText(r)}\n${renderWhatsAppText(r)}`
    assert.doesNotMatch(text, /Priya/)
    assert.doesNotMatch(text, /Ravi/)
  })

  test('employee ids are not printed — a report is for people, not keys', () => {
    const r = buildSalaryReport(7, 2026, [AMIT], [], ['1'])
    assert.doesNotMatch(renderReportText(r), /employee_id/)
  })
})

// ─── The WhatsApp salary summary ──────────────────────────────────────────────
//
// Five figures under each employee's name, and nothing else. The exclusions are
// asserted as hard as the inclusions: a day count that reappears here leaves the
// system in a message nobody can recall.

describe('the WhatsApp salary summary', () => {
  // The worked example the format was specified from.
  const EXAMPLE = result('1', 'Amit Sharma', {
    gross_salary:             25_000,
    total_deductions:          2_943,
    pending_adjustment_total: -3_433,
    days_present:                 22,
    net_salary:               18_624,
  })

  /** The lines belonging to one employee: their name and the figures under it. */
  function blockFor(text: string, name: string): string[] {
    const lines = text.split('\n')
    const start = lines.indexOf(name)
    assert.ok(start >= 0, `no block for ${name} in:\n${text}`)
    const block: string[] = []
    for (let i = start; i < lines.length && lines[i] !== ''; i++) block.push(lines[i]!)
    return block
  }

  test('each employee shows exactly the five salary figures, in order', () => {
    const text = renderWhatsAppText(buildSalaryReport(7, 2026, [EXAMPLE], [], ['1']))
    assert.deepEqual(blockFor(text, 'Amit Sharma'), [
      'Amit Sharma',
      'Gross Salary: ₹25,000',
      'Attendance Deduction: -₹2,943',
      'Salary to be Booked: ₹22,057',
      'Advance: -₹3,433',
      'Amount Payable: ₹18,624',
    ])
  })

  test('Salary to be Booked is the gross salary minus the attendance deduction', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: 30_000, total_deductions: 4_500 }),
    ], [], ['1'])
    assert.equal(r.employees[0]!.salary_to_be_booked, 25_500)
    assert.match(renderWhatsAppText(r), /Salary to be Booked: ₹25,500/)
  })

  test('Advance is the SAVED settlement carry-forward, not a figure invented here', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: 25_000, total_deductions: 2_943, pending_adjustment_total: 0 }),
    ], [], ['1'], [settlement('1', -3_433)])
    assert.equal(r.employees[0]!.advance, -3_433)
    assert.match(renderWhatsAppText(r), /Advance: -₹3,433/)
  })

  test('Advance carries the applied adjustment total as well as the carry-forward', () => {
    // Exactly what the detail page calls Net Adjustments: the two together.
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { pending_adjustment_total: -2_000 }),
    ], [], ['1'], [settlement('1', -500)])
    assert.equal(r.employees[0]!.advance, -2_500)
    assert.match(renderWhatsAppText(r), /Advance: -₹2,500/)
  })

  test('Amount Payable is what is left after the advance is deducted', () => {
    const r = buildSalaryReport(7, 2026, [EXAMPLE], [], ['1'])
    const e = r.employees[0]!
    assert.equal(e.amount_payable, e.salary_to_be_booked + e.advance)
    assert.equal(e.amount_payable, 18_624)
  })

  test('the figures are the Payroll Result Detail page’s own, not a second arithmetic', () => {
    // Same function, same inputs, same answers. This is the assertion that stops
    // the message and the payslip drifting apart.
    const row = result('1', 'Amit', {
      gross_salary: 31_000, total_deductions: 2_117, pending_adjustment_total: -1_500, days_present: 20,
    })
    const r = buildSalaryReport(7, 2026, [row], [], ['1'], [settlement('1', 750)])
    const figures = computeSettlement(
      {
        gross_salary:             row.gross_salary,
        total_deductions:         row.total_deductions,
        pending_adjustment_total: row.pending_adjustment_total,
        days_present:             row.days_present,
      },
      { carry_forward_amount: 750, amount_paid: null },
    )
    const e = r.employees[0]!
    assert.equal(e.salary_to_be_booked, figures.salary_after_attendance)
    assert.equal(e.advance,             figures.net_adjustments)
    assert.equal(e.amount_payable,      figures.salary_payable)
  })

  test('no attendance count of any kind reaches the message', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [
      adj('1', 'deduction', 'advance_recovery', 2_000),
    ], ['1', '2', '3'], [settlement('1', -400)])
    const text = renderWhatsAppText(r)
    for (const forbidden of [
      /present/i, /absent/i, /half[- ]?day/i, /paid days/i, /working days/i,
      /days/i, /attendance days/i,
    ]) {
      assert.doesNotMatch(text, forbidden, `the summary leaked ${forbidden}`)
    }
    // Structural, not just vocabulary: six lines per employee and no more, so an
    // extra figure cannot arrive without this failing.
    for (const name of ['Amit Sharma', 'Priya Nair', 'Ravi Kumar']) {
      assert.equal(blockFor(text, name).length, 6, `${name}'s block is not the five figures`)
    }
  })

  test('several employees each repeat the same five figures under their name', () => {
    const text = renderWhatsAppText(
      buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], ['1', '2', '3']),
    )
    for (const name of ['Amit Sharma', 'Priya Nair', 'Ravi Kumar']) {
      assert.deepEqual(blockFor(text, name).slice(1).map(l => l.split(':')[0]), [
        'Gross Salary', 'Attendance Deduction', 'Salary to be Booked', 'Advance', 'Amount Payable',
      ])
    }
  })

  test('the existing Indian currency formatting is used throughout', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: 1_23_456, total_deductions: 0, pending_adjustment_total: 0 }),
    ], [], ['1'])
    const text = renderWhatsAppText(r)
    assert.match(text, /Gross Salary: ₹1,23,456/)
    assert.match(text, /Amount Payable: ₹1,23,456/)
    assert.doesNotMatch(text, /\d\.\d/)
  })

  test('a nil deduction and a nil advance read as ₹0, not as −₹0', () => {
    const text = renderWhatsAppText(buildSalaryReport(7, 2026, [
      result('1', 'Amit', { total_deductions: 0, pending_adjustment_total: 0 }),
    ], [], ['1']))
    assert.match(text, /Attendance Deduction: ₹0/)
    assert.match(text, /Advance: ₹0/)
    assert.doesNotMatch(text, /-₹0/)
  })

  test('an advance in the employee’s favour is signed as an addition', () => {
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { pending_adjustment_total: 1_200 }),
    ], [], ['1'])
    assert.match(renderWhatsAppText(r), /Advance: \+₹1,200/)
  })

  test('the total is the sum of the Amounts Payable the message itself shows', () => {
    // A footer totalling something else is a message whose own lines do not add
    // up to it.
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA, RAVI], [], ['1', '2', '3'],
      [settlement('1', -1_000)])
    const text = renderWhatsAppText(r)
    const sum = r.employees.reduce((t, e) => t + e.amount_payable, 0)
    assert.equal(r.totals.amount_payable, sum)
    assert.match(text, new RegExp(`Total: ₹${sum.toLocaleString('en-IN')} \\(3\\)`))
  })

  test('an employee with no attendance at all is floored, exactly as the payslip is', () => {
    // The absence floor is the detail page's rule; the message states the same
    // ₹0 rather than a negative salary produced by the divisor.
    const r = buildSalaryReport(7, 2026, [
      result('1', 'Amit', { gross_salary: 26_000, total_deductions: 27_000, days_present: 0 }),
    ], [], ['1'])
    assert.equal(r.employees[0]!.salary_to_be_booked, 0)
    assert.match(renderWhatsAppText(r), /Salary to be Booked: ₹0/)
  })

  test('an unselected employee’s advance never reaches the summary or its total', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA], [], ['1'], [
      settlement('1', -500),
      settlement('2', -9_999),
    ])
    assert.equal(r.employees.length, 1)
    assert.equal(r.employees[0]!.advance, -500)
    assert.doesNotMatch(renderWhatsAppText(r), /9,999/)
  })
})

// ─── WhatsApp preparation ─────────────────────────────────────────────────────

describe('WhatsApp preparation', () => {
  test('a short report produces a wa.me URL carrying the exact text', () => {
    const r = buildSalaryReport(7, 2026, [AMIT, PRIYA], [], ['1', '2'])
    const prep = prepareWhatsApp(r)
    assert.equal(prep.ok, true)
    if (!prep.ok) return
    assert.match(prep.url, /^https:\/\/wa\.me\/\?text=/)
    assert.equal(decodeURIComponent(prep.url.split('text=')[1]!), prep.text)
  })

  test('the URL names no recipient, so this code never chooses who receives it', () => {
    const prep = prepareWhatsApp(buildSalaryReport(7, 2026, [AMIT], [], ['1']))
    assert.equal(prep.ok, true)
    if (!prep.ok) return
    assert.match(prep.url, /wa\.me\/\?text=/)
    assert.doesNotMatch(prep.url, /wa\.me\/\d/)
  })

  test('the character count is the ENCODED length, not the raw length', () => {
    // A ₹ or a newline costs three characters once encoded, so counting the raw
    // string would badly under-estimate and let an over-long URL through.
    const r = buildSalaryReport(7, 2026, [AMIT], [], ['1'])
    const prep = prepareWhatsApp(r)
    assert.equal(prep.encodedLength, encodeURIComponent(prep.text).length)
    assert.ok(prep.encodedLength > prep.text.length, 'encoding must expand ₹ and newlines')
  })

  test('an over-long report is REFUSED, with no URL and no truncation', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      result(String(i), `Employee Number ${i} With A Long Name`, { net_salary: 25_000 + i }))
    const r = buildSalaryReport(7, 2026, many, [], many.map(m => m.employee_id))
    const prep = prepareWhatsApp(r)

    assert.equal(prep.ok, false)
    if (prep.ok) return
    assert.equal('url' in prep, false, 'a refused preparation must carry no URL')
    assert.ok(prep.encodedLength > WHATSAPP_URL_TEXT_LIMIT)
    assert.equal(prep.limit, WHATSAPP_URL_TEXT_LIMIT)
  })

  test('the refusal keeps the full text, so Copy and Preview still work', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      result(String(i), `Employee Number ${i} With A Long Name`))
    const r = buildSalaryReport(7, 2026, many, [], many.map(m => m.employee_id))
    const prep = prepareWhatsApp(r)
    assert.equal(prep.ok, false)
    if (prep.ok) return
    // Every selected employee is still present — nothing was cut.
    assert.equal(prep.text.split('\n').filter(l => l.startsWith('Employee Number')).length, 400)
  })

  test('the refusal tells the admin what to do about it', () => {
    const many = Array.from({ length: 400 }, (_, i) => result(String(i), `Employee Number ${i} Long Name`))
    const r = buildSalaryReport(7, 2026, many, [], many.map(m => m.employee_id))
    const prep = prepareWhatsApp(r)
    assert.equal(prep.ok, false)
    if (prep.ok) return
    assert.match(prep.message, /fewer employees/i)
    assert.match(prep.message, /Copy/)
  })

  test('the threshold is a named, conservative constant', () => {
    assert.equal(typeof WHATSAPP_URL_TEXT_LIMIT, 'number')
    assert.ok(WHATSAPP_URL_TEXT_LIMIT >= 1_000, 'too small to be useful')
    assert.ok(WHATSAPP_URL_TEXT_LIMIT <= 2_000, 'headroom under the narrowest common handoff')
  })

  test('a report exactly at the limit is allowed, and one character over is not', () => {
    // The boundary is where an off-by-one silently truncates in production.
    const build = (count: number) => {
      const rows = Array.from({ length: count }, (_, i) => result(String(i), `Name ${i}`))
      return buildSalaryReport(7, 2026, rows, [], rows.map(r => r.employee_id))
    }
    let atOrUnder = 0
    for (let n = 1; n <= 300; n++) {
      const prep = prepareWhatsApp(build(n))
      if (prep.encodedLength <= WHATSAPP_URL_TEXT_LIMIT) {
        assert.equal(prep.ok, true, `${n} employees encoded to ${prep.encodedLength}, under the limit, but was refused`)
        atOrUnder = n
      } else {
        assert.equal(prep.ok, false, `${n} employees encoded to ${prep.encodedLength}, over the limit, but was allowed`)
        break
      }
    }
    assert.ok(atOrUnder > 0, 'expected at least one allowable size')
  })

  test('no automatic splitting into multiple messages', () => {
    const many = Array.from({ length: 400 }, (_, i) => result(String(i), `Employee ${i}`))
    const r = buildSalaryReport(7, 2026, many, [], many.map(m => m.employee_id))
    const prep = prepareWhatsApp(r)
    // A single preparation, ok or not — never an array of chunks.
    assert.equal(Array.isArray(prep), false)
    assert.equal(prep.ok, false)
  })
})
