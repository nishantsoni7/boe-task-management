/**
 * FOUNDERS' PAYOUTS, the four tabs and the payout form, run for real in a DOM.
 *
 * The sums have their own tests (lib/finance/founderPayouts.test.ts). These check
 * what the page does with them: the states the owner meets first (one side, a
 * family account, a role not set), a payout read as one group, filters that stay
 * hidden until asked for, and that nothing typed is lost or sent wrongly.
 *
 * Run: npm run test:file -- src/app/finance/founders/founders.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { act, createElement, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseFounderBook, summariseYear, type FounderPayout } from '@/lib/finance/founderPayouts'

type Screens = {
  FounderOverview: typeof import('./FounderOverview').FounderOverview
  FounderPayments: typeof import('./FounderPayments').FounderPayments
  NO_FILTERS: typeof import('./FounderPayments').NO_FILTERS
  FounderPlanner: typeof import('./FounderPlanner').FounderPlanner
  FounderAccounts: typeof import('./FounderAccounts').FounderAccounts
  FounderPayoutModal: typeof import('./FounderPayoutModal').FounderPayoutModal
}
let S: Screens

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  const [overview, payments, planner, accounts, modal] = await Promise.all([
    import('./FounderOverview'), import('./FounderPayments'), import('./FounderPlanner'), import('./FounderAccounts'), import('./FounderPayoutModal'),
  ])
  S = {
    FounderOverview: overview.FounderOverview,
    FounderPayments: payments.FounderPayments,
    NO_FILTERS: payments.NO_FILTERS,
    FounderPlanner: planner.FounderPlanner,
    FounderAccounts: accounts.FounderAccounts,
    FounderPayoutModal: modal.FounderPayoutModal,
  }
})

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })
function show(element: Parameters<typeof mount>[0]) {
  const ui = mount(element)
  cleanup = () => ui.unmount()
  return ui
}

const TODAY = '2026-10-31'

const acc = (id: string, display_name: string, side: string, tax_role: string, bank_label: string | null = null, is_active = true) =>
  ({ id, display_name, side, tax_role, bank_label, is_active })

/** Two sides out of balance, somebody over the line, a role not set, an account no longer used. */
const FULL = parseFounderBook({
  accounts: [
    acc('nis', 'Nishant Soni', 'Nishant', 'working_partner', 'HDFC ··4821'),
    acc('nam', 'Namrata Soni', 'Nishant', 'working_partner', 'HDFC ··1123'),
    acc('old', 'Old Account', 'Nishant', 'family', null, false),
    acc('jai', 'Jaishree Soni', 'Nishant', 'family'),
    acc('nit', 'Nitish Bansal', 'Nitish', 'working_partner'),
    acc('fam', 'Family account', 'Nitish', 'unset'),
  ],
  payouts: [
    { id: 'p3', paid_on: '2026-10-22', paid_from: 'hdfc', note: 'Matched for our side', bank_reference: 'UTR9',
      lines: [{ id: 'l1', account_id: 'nis', kind: 'partner_remuneration', amount: 200000 },
              { id: 'l2', account_id: 'jai', kind: 'drawings', amount: 100000 },
              { id: 'l3', account_id: 'nit', kind: 'partner_remuneration', amount: 300000 }] },
    { id: 'p2', paid_on: '2026-07-09', paid_from: 'hdfc', note: null, bank_reference: null,
      lines: [{ id: 'l4', account_id: 'nam', kind: 'incentive', amount: 120000 }] },
    { id: 'p1', paid_on: '2026-05-14', paid_from: 'hdfc_sec', note: null, bank_reference: null,
      lines: [{ id: 'l5', account_id: 'nit', kind: 'partner_remuneration', amount: 1000000 }] },
  ],
  account_years: [{ tax_year: 2026, account_id: 'nis', other_income: 120000 }],
  firm_years: [{ tax_year: 2026, expected_book_profit: 6000000 }],
})

/** The owner's accounts as they are today: one side, two family accounts paid, the partner not. */
const TODAYS = parseFounderBook({
  accounts: [acc('jai', 'Jaishree Soni', 'Nishant', 'family'), acc('nam', 'Namrata Soni', 'Nishant', 'family'), acc('nis', 'Nishant Soni', 'Nishant', 'working_partner')],
  payouts: [
    { id: 't2', paid_on: '2026-10-20', paid_from: 'hdfc', lines: [{ id: 'a', account_id: 'nam', kind: 'drawings', amount: 75000 }] },
    { id: 't1', paid_on: '2026-10-20', paid_from: 'hdfc', lines: [{ id: 'b', account_id: 'jai', kind: 'drawings', amount: 75000 }] },
  ],
})

const fakeDb = () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const supabase = { rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: 'id-1', error: null } } }
  return { calls, supabase: supabase as unknown as SupabaseClient }
}

const heads = (table: Element) => [...table.querySelectorAll('thead th')].map(th => (th.textContent ?? '').trim())

function overview(book = FULL, today = TODAY, taxYear = 2026) {
  let opened = 0
  const ui = show(<S.FounderOverview year={summariseYear(book, taxYear)} todayIso={today} hasAccounts={book.accounts.length > 0}
    onOpenAccounts={() => { opened += 1 }} onNewPayout={() => {}} />)
  return { ui, opened: () => opened }
}

describe('Overview', () => {
  test('the accounts as they are today: one side, and a way to add the other', () => {
    const { ui, opened } = overview(TODAYS)
    assert.match(ui.text(), /Paid in 2026-27/)
    assert.equal(ui.all('[data-testid="founder-gap"]').length, 0)
    ui.click(ui.one('[data-testid="founder-add-side"]'))
    assert.equal(opened(), 1)
    const [accounts] = ui.all('table')
    assert.deepEqual(heads(accounts), ['Account', 'Drawings', 'Total', 'Tax-free room'], 'only the kinds paid get a column')
    assert.equal(ui.all('tfoot').length, 0, 'one side has no grand total to add')
    assert.match(ui.text(), /Not Jaishree Soni’s income: counts as Nishant’s drawing/)
    assert.match(ui.text(), /₹12 L left of ₹12 L · about ₹2.4 L a month/)
  })

  test('two sides: the gap in words, the money by side, a grand total', () => {
    const { ui } = overview()
    assert.match(ui.one('[data-testid="founder-gap"]').textContent ?? '', /₹10 L.*Nishant’s side is behind/)
    assert.equal(ui.all('[data-testid="founder-add-side"]').length, 0)
    const [accounts] = ui.all('table')
    assert.deepEqual(heads(accounts), ['Account', 'Remuneration', 'Incentive', 'Drawings', 'Total', 'Tax-free room'])
    const nishantSide = ui.all('tr.sideRow')[0]
    assert.match(nishantSide.textContent ?? '', /Nishant’s side· 3 accounts₹2,00,000₹1,20,000₹1,00,000₹4,20,000/)
    assert.match(ui.one('tfoot').textContent ?? '', /All accounts₹15,00,000₹1,20,000₹1,00,000₹17,20,000/)
  })

  test('an unused account with no money this year is left out; the room reads in words', () => {
    const { ui, opened } = overview()
    assert.doesNotMatch(ui.text(), /Old Account/)
    assert.match(ui.text(), /₹1 L over the line/)
    assert.match(ui.text(), /₹8.8 L left of ₹10.8 L · about ₹1.76 L a month/, 'other income lowers the person’s own limit')
    ui.click(ui.button('Set the role'))
    assert.equal(opened(), 1)
  })

  test('a closed year says so, and promises no room per month', () => {
    const { ui } = overview(FULL, '2027-05-02')
    assert.match(ui.text(), /Year closed ₹8.8 L under the line/)
    assert.doesNotMatch(ui.text(), /a month/)
  })

  test('a year with no tax rules shows the money and says why there is no room', () => {
    const book = parseFounderBook({ accounts: [acc('nis', 'Nishant Soni', 'Nishant', 'working_partner')], payouts: [
      { id: 'x', paid_on: '2024-06-01', paid_from: 'hdfc', lines: [{ id: 'y', account_id: 'nis', kind: 'drawings', amount: 5000 }] }] })
    const { ui } = overview(book, TODAY, 2024)
    assert.match(ui.text(), /Tax rules for this year are not in the app/)
  })

  test('the months: a real table of twelve, exact on hover, shaded by size, the months to come quiet', () => {
    const { ui } = overview()
    const months = ui.all('table')[1]
    assert.deepEqual(heads(months).slice(1, 3), ['Apr', 'May'])
    assert.equal(heads(months).length, 14)
    assert.equal(months.querySelector('thead th.isNow')?.textContent, 'Oct')
    assert.equal(months.querySelectorAll('thead th.isLater').length, 5)
    assert.equal(months.querySelectorAll('tbody th[scope="row"]').length, 2)
    const nitish = months.querySelectorAll('tbody tr')[1]
    const may = nitish.querySelectorAll('td')[1]
    assert.equal(may.getAttribute('title'), 'Nitish’s side, May 2026: ₹10,00,000')
    assert.match(may.innerHTML, /shade3/)
    assert.doesNotMatch(nitish.querySelectorAll('td')[0].innerHTML, /shade/)
    assert.equal(nitish.querySelectorAll('td')[8].textContent, '·')
  })

  test('no accounts at all: the page says where to start', () => {
    const { ui, opened } = overview(parseFounderBook({}))
    ui.click(ui.button('Add the first account'))
    assert.equal(opened(), 1)
    assert.equal(ui.all('table').length, 0)
  })
})

function payments(lines?: (all: ReturnType<typeof summariseYear>['lines']) => ReturnType<typeof summariseYear>['lines']) {
  const year = summariseYear(FULL, 2026)
  const seen: { edited: FounderPayout[]; deleted: FounderPayout[] } = { edited: [], deleted: [] }
  function Harness() {
    const [filters, setFilters] = useState(S.NO_FILTERS)
    return <S.FounderPayments year={year} lines={lines ? lines(year.lines) : year.lines} filters={filters} setFilters={setFilters}
      sides={['Nishant', 'Nitish']} book={FULL} onEdit={p => seen.edited.push(p)} onDelete={p => seen.deleted.push(p)} />
  }
  return { ui: show(createElement(Harness)), seen }
}

describe('Payments', () => {
  test('a payout is one group: date, company account and note span its lines', () => {
    const { ui } = payments()
    const groups = ui.all('table tbody')
    assert.equal(groups.length, 3)
    const first = groups[0]
    assert.equal(first.querySelectorAll('tr').length, 3)
    assert.deepEqual([...first.querySelectorAll('td[rowspan]')].map(td => td.getAttribute('rowspan')), ['3', '3', '3', '3'])
    assert.match(first.textContent ?? '', /22 Oct 2026Total ₹6,00,000/)
    assert.match(first.textContent ?? '', /Matched for our sideRef UTR9/)
    assert.doesNotMatch(groups[1].textContent ?? '', /Total/, 'one line needs no total of its own')
    assert.match(ui.one('[data-testid="founder-payments-total"]').textContent ?? '', /₹17,20,000 in 3 payouts/)
  })

  test('the columns of a later line are not shifted by the spanned cells', () => {
    const { ui } = payments()
    const rows = ui.all('table tbody')[0].querySelectorAll('tr')
    assert.equal(rows[0].querySelectorAll('td').length, 7)
    assert.equal(rows[1].querySelectorAll('td').length, 3)
    assert.match(rows[1].textContent ?? '', /Jaishree SoniNishant’s side.*Drawings.*₹1,00,000/)
  })

  test('a payout narrowed by the filters says what is hidden, and keeps its whole total', () => {
    const { ui } = payments(all => all.filter(l => l.id === 'l1'))
    const group = ui.all('table tbody')[0]
    assert.match(group.textContent ?? '', /2 more lines hidden by the filters/)
    assert.match(group.textContent ?? '', /Total ₹6,00,000/)
    assert.equal(group.querySelector('td[rowspan]')?.getAttribute('rowspan'), '2')
    assert.match(ui.one('[data-testid="founder-payments-total"]').textContent ?? '', /₹2,00,000 in 1 payout$/)
  })

  test('the filters stay out of the way until asked for, and say how many are on', () => {
    const { ui } = payments()
    assert.equal(ui.all('[role="dialog"]').length, 0)
    const button = ui.one('[data-testid="founder-filters-button"]')
    ui.click(button)
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    const panel = ui.one('[role="dialog"]')
    assert.deepEqual([...panel.querySelectorAll('label > span')].map(s => s.textContent), ['Account', 'Kind', 'Side', 'Paid from', 'Month'])
    assert.equal(ui.all('[data-testid="founder-filters-button"] .toolCount').length, 0)

    const select = panel.querySelectorAll('select')[1]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    act(() => { setter.call(select, 'drawings'); select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(ui.one('.toolCount').textContent, '1')
    assert.equal(button.getAttribute('aria-label'), 'Filters, 1 on')
  })

  test('Clear filters leaves the search as it was', () => {
    const { ui } = payments()
    ui.type(ui.one<HTMLInputElement>('input[type="search"]'), 'Nitish')
    ui.click(ui.one('[data-testid="founder-filters-button"]'))
    const select = ui.one('[role="dialog"]').querySelector('select')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    act(() => { setter.call(select, 'nit'); select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    ui.click(ui.button('Clear filters'))
    assert.equal(ui.all('.toolCount').length, 0)
    assert.equal(ui.one<HTMLInputElement>('input[type="search"]').value, 'Nitish')
  })

  test('Change and Delete are named for the screen reader and act on that payout', () => {
    const { ui, seen } = payments()
    ui.click(ui.one('button[aria-label="Change the payout of 14 May 2026"]'))
    ui.click(ui.one('button[aria-label="Delete the payout of 22 Oct 2026"]'))
    assert.equal(seen.edited[0].id, 'p1')
    assert.equal(seen.deleted[0].id, 'p3')
  })

  test('a phone gets the same payouts as cards', () => {
    const { ui } = payments()
    assert.equal(ui.all('.ledgerCards .card').length, 3)
    assert.match(ui.all('.ledgerCards .card')[0].textContent ?? '', /From HDFC PRI · Ref UTR9/)
  })

  test('an empty list says whether the filters did it', () => {
    const none = payments(() => [])
    assert.match(none.ui.text(), /No payout recorded for 2026-27/)
    none.ui.type(none.ui.one<HTMLInputElement>('input[type="search"]'), 'zzz')
    assert.match(none.ui.text(), /No payment matches these filters/)
  })
})

function planner(book = FULL, today = TODAY) {
  const db = fakeDb()
  let changed = 0
  const shown: string[] = []
  const ui = show(<S.FounderPlanner supabase={db.supabase} year={summariseYear(book, 2026)} todayIso={today}
    onChanged={async () => { changed += 1 }} show={message => { shown.push(message) }} />)
  return { ui, db, changed: () => changed, shown }
}

describe('Tax planner', () => {
  test('the firm’s ceiling reads as a sum', () => {
    const { ui } = planner()
    assert.equal(ui.one<HTMLInputElement>('.ceilingSum input').value, '60,00,000')
    assert.match(ui.one('.ceilingSum').textContent ?? '', /₹37.8 L.*₹16.2 L.*₹21.6 L/)
  })

  test('with no book profit yet it asks for one', () => {
    const { ui } = planner(TODAYS)
    assert.match(ui.one('.ceilingSum').textContent ?? '', /Type the book profit/)
    assert.equal(ui.all('.ceilingFoot [role="img"]').length, 0)
  })

  test('seven columns, the people grouped by side, nobody unused and unpaid', () => {
    const { ui } = planner()
    const table = ui.one('table')
    assert.deepEqual(heads(table), ['Account', 'Role in BOE', 'Counts as income', 'Other income', 'Room left', 'Per month (5 left)', 'What if you pay more'])
    assert.equal(ui.all('tr.sideRow').length, 2)
    assert.doesNotMatch(table.textContent ?? '', /Old Account/)
  })

  test('the limit stays in view, so 12 L less income less other income is the room', () => {
    const { ui } = planner()
    const nishant = ui.all('tbody tr').find(tr => /Nishant Soni/.test(tr.textContent ?? ''))
    assert.match(nishant?.textContent ?? '', /₹8.8 L left of the ₹12 L limit/)
    assert.equal((nishant?.querySelector('input[aria-label="Other income of Nishant Soni"]') as HTMLInputElement).value, '1,20,000')
  })

  test('family: no room and no what-if, the other income box stays', () => {
    const { ui } = planner()
    const jaishree = ui.all('tbody tr').find(tr => /Jaishree Soni/.test(tr.textContent ?? ''))!
    assert.match(jaishree.textContent ?? '', /₹0of ₹1,00,000 paid/)
    assert.match(jaishree.textContent ?? '', /Not Jaishree Soni’s income: it counts as Nishant’s drawing/)
    assert.equal(jaishree.querySelector('td[colspan="3"]') !== null, true)
    assert.equal(jaishree.querySelectorAll('input').length, 1)
    assert.equal(jaishree.querySelector('input')?.getAttribute('aria-label'), 'Other income of Jaishree Soni')
  })

  test('someone over the line is told to stop', () => {
    const { ui } = planner()
    const nitish = ui.all('tbody tr').find(tr => /Nitish Bansal/.test(tr.textContent ?? ''))!
    assert.match(nitish.textContent ?? '', /₹1 L over the line/)
    assert.match(nitish.textContent ?? '', /Stop for this year/)
  })

  test('what if: no tax, then the tax, in the one cell', () => {
    const { ui } = planner()
    const box = ui.one<HTMLInputElement>('input[aria-label="Try an amount for Namrata Soni"]')
    ui.type(box, '5,00,000')
    assert.match(box.closest('td')?.textContent ?? '', /No tax/)
    ui.type(box, '12,00,000')
    assert.match(box.closest('td')?.textContent ?? '', /₹81,120 tax/)   // ₹13.2 L: 78,000 by the slabs + 4%
  })

  test('other income saves on leaving the box, in rupees, and is grouped again', async () => {
    const { ui, db, changed } = planner()
    const box = ui.one<HTMLInputElement>('input[aria-label="Other income of Namrata Soni"]')
    ui.type(box, '250000')
    await act(async () => { box.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })) })
    await ui.settle()
    assert.deepEqual(db.calls, [{ name: 'founder_payout_account_year_save', args: { p_tax_year: 2026, p_account_id: 'nam', p_other_income: 250000 } }])
    assert.equal(changed(), 1)
    assert.equal(ui.one<HTMLInputElement>('input[aria-label="Other income of Namrata Soni"]').value, '2,50,000')
  })

  test('leaving a box unchanged saves nothing', async () => {
    const { ui, db } = planner()
    const box = ui.one<HTMLInputElement>('input[aria-label="Other income of Nishant Soni"]')
    await act(async () => { box.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })) })
    await ui.settle()
    assert.equal(db.calls.length, 0)
  })

  test('a book profit may be a loss', async () => {
    const { ui, db } = planner()
    const box = ui.one<HTMLInputElement>('.ceilingSum input')
    ui.type(box, '-2,50,000')
    await act(async () => { box.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })) })
    await ui.settle()
    assert.deepEqual(db.calls[0].args, { p_tax_year: 2026, p_expected_book_profit: -250000 })
    assert.equal(ui.one<HTMLInputElement>('.ceilingSum input').value, '-2,50,000')
  })

  test('the warning to see the CA is always in view; the explanations fold away', () => {
    const { ui } = planner()
    const details = ui.one('details')
    assert.equal(details.hasAttribute('open'), false)
    assert.match(details.textContent ?? '', /The ₹12 lakh line/)
    assert.match(details.textContent ?? '', /New regime slabs/)
    const warning = ui.all('p').find(p => /show this page to your CA/.test(p.textContent ?? ''))
    assert.ok(warning, 'the CA warning is on the page')
    assert.equal(warning?.closest('details'), null)
  })

  test('a year with no rules says so instead of guessing', () => {
    const db = fakeDb()
    const ui = show(<S.FounderPlanner supabase={db.supabase} year={summariseYear(FULL, 2024)} todayIso={TODAY} onChanged={async () => {}} show={() => {}} />)
    assert.match(ui.text(), /are not in the app/)
    assert.equal(ui.all('table').length, 0)
  })
})

describe('Accounts', () => {
  const accounts = () => {
    const db = fakeDb()
    const ui = show(<S.FounderAccounts supabase={db.supabase} year={summariseYear(FULL, 2026)} sides={['Nishant', 'Nitish']} onChanged={async () => {}} show={() => {}} />)
    return { ui, db }
  }

  test('grouped by side, an unused account last in its side', () => {
    const { ui } = accounts()
    assert.deepEqual(heads(ui.one('table')), ['Name', 'Role in BOE', 'Bank', 'Paid in 2026-27', 'Change'])
    const groups = ui.all('table tbody')
    assert.deepEqual([...groups[0].querySelectorAll('tr.rowOpen .name')].map(n => n.textContent), ['Nishant Soni', 'Namrata Soni', 'Jaishree Soni', 'Old Account'])
    assert.match(groups[0].textContent ?? '', /Old AccountNot used any more/)
    assert.match(groups[0].querySelector('tr.sideRow')?.textContent ?? '', /Nishant’s side· 4 accounts₹4,20,000/)
  })

  test('a role not set stands out; the others are plain words', () => {
    const { ui } = accounts()
    assert.equal(ui.all('.fin-pill--zero').length, 1)
    assert.equal(ui.one('.fin-pill--zero').textContent, 'Role not set yet')
  })

  test('a row opens its account by click and by keyboard', () => {
    const { ui } = accounts()
    ui.click(ui.all('tr.rowOpen')[1])
    assert.equal(ui.one('[role="dialog"]').getAttribute('aria-label'), 'Change Namrata Soni')
    ui.click(ui.button('Cancel'))
    assert.equal(ui.all('[role="dialog"]').length, 0)
    act(() => { ui.all('tr.rowOpen')[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    assert.equal(ui.one('[role="dialog"]').getAttribute('aria-label'), 'Change Nishant Soni')
  })

  test('a full account number is refused before it reaches the database', () => {
    const { ui, db } = accounts()
    ui.click(ui.button('Add account'))
    ui.type(ui.one<HTMLInputElement>('input[placeholder="e.g. Namrata"]'), 'Someone')
    ui.type(ui.one<HTMLInputElement>('input[placeholder="e.g. Nishant"]'), 'Nishant')
    ui.type(ui.one<HTMLInputElement>('input[placeholder="e.g. HDFC ··1123"]'), 'HDFC 123456789')
    assert.match(ui.text(), /Type only the last 4 digits/)
    assert.equal(ui.all('[role="dialog"] button').find(b => b.textContent === 'Add account')?.hasAttribute('disabled'), true)
    assert.equal(db.calls.length, 0)
  })
})

describe('The payout form', () => {
  const form = () => {
    const db = fakeDb()
    let saved: [string, string] | null = null
    const ui = show(<S.FounderPayoutModal supabase={db.supabase} book={FULL} editing={null} todayIso={TODAY} onClose={() => {}}
      onSaved={(message, paidOn) => { saved = [message, paidOn] }} />)
    return { ui, db, saved: () => saved }
  }

  test('picking accounts and typing a total splits it, says it adds up, and warns about the tax line', async () => {
    const { ui, db, saved } = form()
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Total amount in rupees"]'), '2,00,000')
    ui.click(ui.button('Nishant Soni'))
    ui.click(ui.button('Jaishree Soni'))
    assert.equal(ui.one<HTMLInputElement>('input[aria-label="Amount to Nishant Soni"]').value, '100000')
    assert.match(ui.one('.sumOk').textContent ?? '', /Adds up: ₹2,00,000 into 2 accounts/)
    assert.match(ui.text(), /Still tax-free/)
    assert.match(ui.text(), /Not Jaishree Soni’s income: it counts as Nishant’s drawing/)
    ui.click(ui.button('Save payout'))
    await ui.settle()
    assert.equal(db.calls[0].name, 'founder_payout_save')
    assert.deepEqual(db.calls[0].args.p_lines, [
      { account_id: 'nis', kind: 'partner_remuneration', amount: 100000 },
      { account_id: 'jai', kind: 'drawings', amount: 100000 },
    ])
    assert.deepEqual(saved(), ['Payout saved: ₹2,00,000 into 2 accounts', TODAY])
  })

  test('a hand-typed split that does not add up cannot be saved and offers the fix', () => {
    const { ui } = form()
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Total amount in rupees"]'), '2,00,000')
    ui.click(ui.button('Nishant Soni'))
    ui.click(ui.button('Jaishree Soni'))
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Amount to Nishant Soni"]'), '50000')
    assert.match(ui.one('.sumOff').textContent ?? '', /₹50,000 short of the total/)
    assert.equal(ui.button('Save payout').hasAttribute('disabled'), true)
    ui.click(ui.one('.sumOff button'))
    assert.equal(ui.all('.sumOff').length, 0)
    assert.equal(ui.button('Save payout').hasAttribute('disabled'), false)
  })

  test('going over the tax-free line is said before saving', () => {
    const { ui } = form()
    // ₹2 L paid and ₹1.2 L other income, so ₹9.3 L more lands at ₹12.5 L.
    ui.type(ui.one<HTMLInputElement>('input[aria-label="Total amount in rupees"]'), '9,30,000')
    ui.click(ui.button('Nishant Soni'))
    assert.match(ui.text(), /Over the tax-free line by ₹50,000/)
    assert.match(ui.text(), /tax for the year about ₹52,000/)
  })

  test('no lines yet: no empty box, and the form says what it needs', () => {
    const { ui } = form()
    assert.equal(ui.all('.lines').length, 0)
    assert.equal(ui.button('Split equally').hasAttribute('disabled'), true)
    assert.equal(ui.button('Save payout').hasAttribute('disabled'), true)
  })
})
