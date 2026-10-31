/**
 * FOUNDERS' PAYOUTS (20270501000000): the tax arithmetic, the financial year,
 * the sums the page draws, the equal split, and the shape of the migration.
 *
 * The owner's rules (2026-10-29): money paid into the partners' and their
 * families' accounts is recorded per account and per kind; Namrata's incentive
 * is kept apart from the common remuneration; the two sides stay equal on the
 * common payments; Jaishree is family, not working in BOE, so a payment to her
 * is not her income; only the owner sees any of it, administrators included.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TAX_RULES,
  newRegimeTax,
  remunerationCeiling,
  roomLeft,
  rulesFor,
  slabTax,
  taxFreeLimit,
  taxIfPaid,
} from './founderPayoutTax'
import {
  accountsBySide,
  availableTaxYears,
  draftProblems,
  equalShareGap,
  formatLakh,
  formatRupees,
  groupByPayout,
  kindsPaidIn,
  monthShade,
  monthsLeftInTaxYear,
  parseFounderBook,
  splitEqually,
  summariseYear,
  taxYearLabel,
  taxYearMonths,
  taxYearOf,
} from './founderPayouts'
import { PAYMENTS_SHEET_HEADER, founderErrorMessage, founderExportFileName, founderWorkbook } from '../../app/finance/founders/founderPayoutsData'

const R = TAX_RULES[2026]

describe('the tax rules of 2026-27 (new regime)', () => {
  test('slabs: nil to ₹4 L, then 5% steps of ₹4 L up to 30%', () => {
    assert.equal(slabTax(400000, R), 0)
    assert.equal(slabTax(800000, R), 20000)
    assert.equal(slabTax(1200000, R), 60000)
    assert.equal(slabTax(1600000, R), 120000)
    assert.equal(slabTax(2400000, R), 300000)
    assert.equal(slabTax(3000000, R), 480000)
  })

  test('nothing to pay at or below ₹12 lakh; marginal relief just above; cess on top', () => {
    assert.equal(newRegimeTax(1200000, R), 0)
    assert.equal(newRegimeTax(1250000, R), 52000)        // relief: 50,000 + 4%
    assert.equal(newRegimeTax(1270000, R), 72800)        // relief still binds (70,000 + 4%)
    assert.equal(newRegimeTax(1300000, R), 78000)        // slabs bind: 75,000 + 4%
    assert.equal(newRegimeTax(1500000, R), 109200)
  })

  test('the tax-free limit depends on the role', () => {
    assert.equal(taxFreeLimit('working_partner', R), 1200000)
    assert.equal(taxFreeLimit('employee', R), 1275000)   // ₹75,000 standard deduction, salary only
    assert.equal(taxFreeLimit('family', R), null)        // not their income
    assert.equal(taxFreeLimit('unset', R), null)
  })

  test('room left takes off other income and what was already received', () => {
    assert.equal(roomLeft('working_partner', 505000, 40000, R), 655000)
    assert.equal(roomLeft('working_partner', 1250000, 0, R), -50000)
    assert.equal(roomLeft('employee', 600000, 100000, R), 575000)
    assert.equal(roomLeft('family', 315000, 0, R), null)
  })

  test('tax if more is paid: a partner gets no standard deduction, an employee does', () => {
    assert.equal(taxIfPaid('working_partner', 1100000, 0, 100000, R), 0)
    assert.equal(taxIfPaid('working_partner', 1100000, 0, 150000, R), 52000)
    assert.equal(taxIfPaid('employee', 1100000, 0, 150000, R), 0)          // 12.5 L salary − 75,000
    assert.equal(taxIfPaid('family', 0, 0, 500000, R), null)
  })

  test('the firm’s ceiling: ₹3 L or 90% of the first ₹6 L, then 60% of the rest', () => {
    assert.equal(remunerationCeiling(2000000, R), 1380000)   // the published worked example
    assert.equal(remunerationCeiling(4000000, R), 2580000)
    assert.equal(remunerationCeiling(200000, R), 300000)     // the floor
    assert.equal(remunerationCeiling(-500000, R), 300000)    // a loss still allows the floor
  })

  test('2025-26 uses the same rules; a later year borrows them and says so; earlier years have none', () => {
    assert.deepEqual(rulesFor(2025), { rules: TAX_RULES[2025], assumed: false })
    assert.equal(rulesFor(2026)?.assumed, false)
    assert.equal(rulesFor(2027)?.assumed, true)
    assert.equal(rulesFor(2027)?.rules.rebateIncomeLimit, 1200000)
    assert.equal(rulesFor(2024), null)
  })
})

describe('the financial year', () => {
  test('April onwards is that year; January to March is the year before', () => {
    assert.equal(taxYearOf('2026-04-01'), 2026)
    assert.equal(taxYearOf('2026-03-31'), 2025)
    assert.equal(taxYearOf('2027-01-15'), 2026)
    assert.equal(taxYearLabel(2026), '2026-27')
    assert.equal(taxYearLabel(2099), '2099-00')
  })

  test('months run April to March', () => {
    const m = taxYearMonths(2026)
    assert.equal(m.length, 12)
    assert.equal(m[0], '2026-04'); assert.equal(m[8], '2026-12'); assert.equal(m[9], '2027-01'); assert.equal(m[11], '2027-03')
  })

  test('months left after the current one', () => {
    assert.equal(monthsLeftInTaxYear('2026-10-29', 2026), 5)
    assert.equal(monthsLeftInTaxYear('2027-03-10', 2026), 0)
    assert.equal(monthsLeftInTaxYear('2026-04-01', 2026), 11)
    assert.equal(monthsLeftInTaxYear('2026-10-29', 2025), 0)
    assert.equal(monthsLeftInTaxYear('2026-02-01', 2026), 12)
  })
})

// The owner's own example, plus an incentive and a closed year.
const RAW = {
  accounts: [
    { id: 'a-nam', display_name: 'Namrata', side: 'Nishant', tax_role: 'working_partner', bank_label: 'HDFC ··1123', is_active: true },
    { id: 'a-jai', display_name: 'Jaishree', side: 'Nishant', tax_role: 'family', bank_label: null, is_active: true },
    { id: 'a-nit', display_name: 'Nitish', side: 'Nitish', tax_role: 'working_partner', bank_label: null, is_active: true },
    { id: 'a-odd', display_name: 'Odd', side: 'Nitish', tax_role: 'nonsense', bank_label: '', is_active: false },
  ],
  payouts: [
    { id: 'p3', paid_on: '2026-10-28', paid_from: 'hdfc', note: 'Matched Nitish', bank_reference: null,
      lines: [{ id: 'l5', account_id: 'a-nam', kind: 'partner_remuneration', amount: 75000 },
              { id: 'l6', account_id: 'a-jai', kind: 'drawings', amount: 75000 }] },
    { id: 'p2', paid_on: '2026-10-28', paid_from: 'hdfc', note: null, bank_reference: null,
      lines: [{ id: 'l4', account_id: 'a-nit', kind: 'partner_remuneration', amount: 150000 }] },
    { id: 'p1', paid_on: '2026-09-29', paid_from: 'hdfc_sec', note: '', bank_reference: 'UTR1',
      lines: [{ id: 'l3', account_id: 'a-nam', kind: 'incentive', amount: 80000.5 },
              { id: 'lx', account_id: 'a-nam', kind: 'bonus', amount: 1 }] },
    { id: 'p0', paid_on: '2026-03-05', paid_from: 'hdfc', note: null, bank_reference: null,
      lines: [{ id: 'l1', account_id: 'a-nam', kind: 'partner_remuneration', amount: 290000 }] },
    { id: 'bad', paid_on: 'yesterday', paid_from: 'hdfc', lines: [] },
  ],
  account_years: [{ tax_year: 2026, account_id: 'a-nam', other_income: 40000 }],
  firm_years: [{ tax_year: 2026, expected_book_profit: 4000000 }, { tax_year: 2025, expected_book_profit: null }],
}

describe('reading the book', () => {
  const book = parseFounderBook(RAW)

  test('unknown roles become "not set", unknown kinds and undated payouts are dropped', () => {
    assert.equal(book.accounts.find(a => a.id === 'a-odd')?.taxRole, 'unset')
    assert.equal(book.accounts.find(a => a.id === 'a-odd')?.bankLabel, null)
    assert.equal(book.accounts.find(a => a.id === 'a-odd')?.isActive, false)
    assert.deepEqual(book.payouts.map(p => p.id), ['p3', 'p2', 'p1', 'p0'])
    assert.deepEqual(book.payouts.find(p => p.id === 'p1')?.lines.map(l => [l.kind, l.paise]), [['incentive', 8000050]])
    assert.equal(book.payouts.find(p => p.id === 'p1')?.note, null)
    assert.equal(book.otherIncome.get('2026:a-nam'), 4000000)
    assert.equal(book.bookProfit.get(2026), 400000000)
    assert.equal(book.bookProfit.get(2025), null)
    assert.deepEqual(parseFounderBook(null), { accounts: [], payouts: [], otherIncome: new Map(), bookProfit: new Map() })
  })

  test('years: every year with a payout, and the current one, newest first', () => {
    assert.deepEqual(availableTaxYears(book, '2026-10-29'), [2026, 2025])
    assert.deepEqual(availableTaxYears(book, '2027-05-01'), [2027, 2026, 2025])
  })

  test('the year’s sums: per account by kind, incentive apart, family money is not income', () => {
    const y = summariseYear(book, 2026)
    assert.equal(y.payoutCount, 3)
    assert.equal(y.totalPaise, 38000050)
    const nam = y.accounts.find(a => a.account.id === 'a-nam')!
    assert.equal(nam.totalPaise, 15500050)
    assert.equal(nam.byKind.get('partner_remuneration'), 7500000)
    assert.equal(nam.byKind.get('incentive'), 8000050)
    assert.equal(nam.incomePaise, 15500050)
    assert.equal(nam.otherIncomePaise, 4000000)
    const jai = y.accounts.find(a => a.account.id === 'a-jai')!
    assert.equal(jai.totalPaise, 7500000)
    assert.equal(jai.incomePaise, 0)
    assert.equal(y.partnerRemunerationPaise, 7500000 + 8000050 + 15000000)
    assert.equal(y.bookProfitPaise, 400000000)
    assert.equal(y.months.get('2026-10')?.get('Nishant'), 15000000)
    assert.equal(y.months.get('2026-10')?.get('Nitish'), 15000000)
    assert.equal(y.months.get('2026-09')?.get('Nishant'), 8000050)
  })

  test('the two sides are equal on the common payments once incentive is left out', () => {
    const y = summariseYear(book, 2026)
    const nishant = y.sides.find(s => s.side === 'Nishant')!
    assert.equal(nishant.totalPaise, 23000050)
    assert.equal(nishant.incentivePaise, 8000050)
    assert.equal(nishant.equalSharePaise, 15000000)
    assert.deepEqual(equalShareGap(y.sides), { ahead: 'Nishant', behind: 'Nitish', paise: 0 })
    const y25 = summariseYear(book, 2025)
    assert.deepEqual(equalShareGap(y25.sides), { ahead: 'Nishant', behind: 'Nitish', paise: 29000000 })
    assert.equal(equalShareGap([]), null)
  })

  test('only the kinds with money this year get a column, in their usual order', () => {
    assert.deepEqual(kindsPaidIn(summariseYear(book, 2026)).map(k => k.value), ['partner_remuneration', 'incentive', 'drawings'])
    assert.deepEqual(kindsPaidIn(summariseYear(book, 2025)).map(k => k.value), ['partner_remuneration'])
    assert.deepEqual(kindsPaidIn(summariseYear(book, 2024)), [])
  })

  test('accounts sit under their side; a side with nobody left to show is dropped', () => {
    const y = summariseYear(book, 2026)
    assert.deepEqual(accountsBySide(y).map(g => [g.side.side, g.accounts.map(a => a.account.id)]),
      [['Nishant', ['a-nam', 'a-jai']], ['Nitish', ['a-nit', 'a-odd']]])
    assert.deepEqual(accountsBySide(y, a => a.account.id === 'a-jai').map(g => g.side.side), ['Nishant'])
  })

  test('a month is shaded against the year’s largest month, and nothing paid is never shaded', () => {
    assert.equal(monthShade(0, 1000), 0)
    assert.equal(monthShade(100, 0), 0)
    assert.equal(monthShade(-5, 1000), 0)
    assert.equal(monthShade(1, 1000), 1)
    assert.equal(monthShade(400, 1000), 1)
    assert.equal(monthShade(401, 1000), 2)
    assert.equal(monthShade(750, 1000), 2)
    assert.equal(monthShade(751, 1000), 3)
    assert.equal(monthShade(1000, 1000), 3)
  })

  test('flat lines go back under their payouts, keeping the order they came in', () => {
    const groups = groupByPayout(summariseYear(book, 2026).lines)
    assert.deepEqual(groups.map(g => [g.payout.id, g.lines.map(l => l.id)]), [['p3', ['l5', 'l6']], ['p2', ['l4']], ['p1', ['l3']]])
    assert.deepEqual(groupByPayout([]), [])
  })
})

describe('a new payout', () => {
  test('split equally in whole rupees, the remainder to the first account', () => {
    assert.deepEqual(splitEqually(15000000, 2), [7500000, 7500000])
    assert.deepEqual(splitEqually(10000000, 3), [3333400, 3333300, 3333300])
    assert.deepEqual(splitEqually(10050, 2), [5050, 5000])
    assert.deepEqual(splitEqually(0, 2), [0, 0])
    assert.deepEqual(splitEqually(500, 0), [])
  })

  test('what stops a save', () => {
    const ok = { paidOn: '2026-10-28', paidFrom: 'hdfc', totalPaise: 15000000,
      lines: [{ accountId: 'a', kind: 'partner_remuneration' as const, paise: 7500000 }, { accountId: 'b', kind: 'drawings' as const, paise: 7500000 }] }
    assert.deepEqual(draftProblems(ok, '2026-10-29'), [])
    assert.match(draftProblems({ ...ok, paidOn: '2026-10-30' }, '2026-10-29').join(), /today or earlier/)
    assert.match(draftProblems({ ...ok, paidFrom: 'sbi' }, '2026-10-29').join(), /company account/)
    assert.match(draftProblems({ ...ok, lines: [] }, '2026-10-29').join(), /at least one account/)
    assert.match(draftProblems({ ...ok, totalPaise: 15000100 }, '2026-10-29').join(), /do not add up/)
    assert.match(draftProblems({ ...ok, lines: [ok.lines[0], { ...ok.lines[0] }] }, '2026-10-29').join(), /appears twice/)
    assert.match(draftProblems({ ...ok, lines: [{ ...ok.lines[0], paise: 0 }] }, '2026-10-29').join(), /needs an amount/)
  })

  test('money is shown in rupees, paise only when there are some, lakhs on tiles', () => {
    assert.equal(formatRupees(7500000), '₹75,000')
    assert.equal(formatRupees(8000050), '₹80,000.50')
    assert.equal(formatRupees(-5000000), '−₹50,000')
    assert.equal(formatLakh(65500000), '₹6.55 L')
    assert.equal(formatLakh(15000000), '₹1.5 L')
    assert.equal(formatLakh(120000000), '₹12 L')
    assert.equal(formatLakh(7500000), '₹75,000')
  })
})

describe('the page’s words and the Excel file', () => {
  test('database refusals become plain sentences', () => {
    assert.equal(founderErrorMessage({ message: 'FOUNDERS_FORBIDDEN: finance.founder_payouts is required' }), 'You do not have access to Founders’ payouts.')
    assert.equal(founderErrorMessage({ message: 'FOUNDERS_INVALID: the date must be today or earlier' }), 'The date must be today or earlier')
    assert.match(founderErrorMessage({ message: 'Could not find the function public.founder_payouts_read without parameters in the schema cache' }), /migration 20270501000000/)
  })

  test('two sheets: the lines as shown, and the whole year per account with the room left', () => {
    const book = parseFounderBook(RAW)
    const year = summariseYear(book, 2026)
    const [payments, perAccount] = founderWorkbook(year, year.lines.filter(l => l.kind === 'incentive'))
    assert.equal(payments.name, 'Payments 2026-27')
    assert.deepEqual(payments.rows[0], PAYMENTS_SHEET_HEADER)
    assert.deepEqual(payments.rows.slice(1), [['2026-09-29', 'Namrata', 'Nishant', 'Working partner', 'Incentive (orders converted)', 80000.5, 'HDFC SEC', 'UTR1', '']])
    assert.equal(perAccount.name, 'Per account 2026-27')
    const nam = perAccount.rows.find(r => r[0] === 'Namrata')!
    const header = perAccount.rows[0]
    assert.equal(nam[header.indexOf('Total (₹)')], 155000.5)
    assert.equal(nam[header.indexOf('Room left (₹)')], 1200000 - 40000 - 155000.5)
    const jai = perAccount.rows.find(r => r[0] === 'Jaishree')!
    assert.equal(jai[header.indexOf('Counts as their income (₹)')], 0)
    assert.equal(jai[header.indexOf('Tax-free limit (₹)')], null)
    assert.equal(perAccount.rows.some(r => r[0] === 'Odd'), false)
    assert.equal(founderExportFileName(2026, '2026-10-29'), 'founders-payouts-2026-27-2026-10-29.xlsx')
  })
})

describe('the migration (20270501000000)', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20270501000000_finance_founder_payouts.sql'), 'utf8')

  test('holds no account number or other long digit run (the repository is public)', () => {
    // Migration versions (14 digits, starting 20) are the only long numbers allowed.
    assert.equal(/\d{10,}/.test(sql.replace(/\b20\d{12}\b/g, '')), false)
  })

  test('the door asks for an explicit grant and has no admin branch', () => {
    const door = sql.slice(sql.indexOf('create or replace function public.assert_founder_payouts_door()'), sql.indexOf('§5.'))
    assert.match(door, /public\.actor_has_permission\('finance', 'founder_payouts'\)/)
    assert.doesNotMatch(door, /actor_has_module_permission/)
    assert.doesNotMatch(door, /role\s*=\s*'admin'/)
  })

  test('the tables have no policies and are revoked from anon and authenticated', () => {
    assert.doesNotMatch(sql, /create policy/i)
    assert.match(sql, /revoke all on public\.%I from public, anon, authenticated/)
  })

  test('only the owner account is seeded with the grant', () => {
    const seeds = sql.match(/insert into public\.employee_permission_overrides/g) ?? []
    assert.equal(seeds.length, 1)
    assert.match(sql, /where u\.employee_code = 'TEST-001'/)
  })
})
