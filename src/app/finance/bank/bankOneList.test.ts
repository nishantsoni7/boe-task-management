/**
 * BANK STATEMENTS: ONE LIST FOR BOTH ACCOUNTS.
 *
 * A payment recorded against the wrong HDFC account could not be seen from the other
 * tab, so the page always reads both accounts and only narrows what is on screen.
 *
 * Run: npm run test:file -- src/app/finance/bank/bankOneList.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { combinedRange, inAccount, loadMonthLines, loadStoredRanges, matchesBankLineId } from './bankStatementsModel'
import { bankLineId } from '@/lib/finance/bankStatement'

const read = (f: string) => readFileSync(join(process.cwd(), 'src/app/finance/bank', f), 'utf8').replace(/\r\n/g, '\n')

/** Answers each table read, and records what was asked of it. */
function stub(pages: (a: number) => { data: unknown; error: unknown }) {
  const asked: string[] = []
  const query = (a = 0) => {
    const q: Record<string, unknown> = {
      then: (done: (r: unknown) => unknown) => Promise.resolve(pages(a)).then(done),
      range: (from: number) => { asked.push(`range ${from}`); return query(from) },
    }
    for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) {
      q[m] = (...args: unknown[]) => { asked.push(`${m} ${args[0]}${args[1] === undefined ? '' : ` ${args[1]}`}`); return q }
    }
    return q
  }
  return { supabase: { from: () => query() } as unknown as SupabaseClient, asked }
}

describe('which rows an account filter keeps', () => {
  test('all means both HDFC accounts, and nothing else', () => {
    assert.equal(inAccount('hdfc', 'all'), true)
    assert.equal(inAccount('hdfc_sec', 'all'), true)
    assert.equal(inAccount('pnb', 'all'), false)
  })

  test('one account keeps only that account', () => {
    assert.equal(inAccount('hdfc', 'hdfc'), true)
    assert.equal(inAccount('hdfc_sec', 'hdfc'), false)
  })
})

describe('the dates across both accounts', () => {
  test('earliest first date and latest last date, whichever account holds them', () => {
    assert.deepEqual(
      combinedRange({ hdfc: { first: '2026-08-05', last: '2026-10-29' }, hdfc_sec: { first: '2026-07-01', last: '2026-10-31' } }),
      { first: '2026-07-01', last: '2026-10-31' },
    )
  })

  test('one account alone is enough, and none is null', () => {
    assert.deepEqual(combinedRange({ hdfc_sec: { first: '2026-07-01', last: '2026-10-31' } }), { first: '2026-07-01', last: '2026-10-31' })
    assert.equal(combinedRange({}), null)
  })

  test('an account with no statement is left out', async () => {
    const { supabase } = stub(() => ({ data: [], error: null }))
    assert.deepEqual(await loadStoredRanges(supabase), {})
  })
})

describe('the month read', () => {
  const row = { id: 'L', withdrawal: 0, deposit: 1, balance: 1, bank_line_payment_links: [], bank_line_expense_links: [] }

  test('asks for no account, and keeps a fixed order across both', async () => {
    const { supabase, asked } = stub(() => ({ data: [row], error: null }))
    await loadMonthLines(supabase, '2026-10')
    assert.ok(!asked.some(a => a.startsWith('eq account')))
    assert.deepEqual(asked.filter(a => a.startsWith('order')).map(a => a.split(' ')[1]), ['line_date', 'account', 'seq'])
  })

  test('goes on past one page, so no credit is cut off', async () => {
    const full = Array.from({ length: 1000 }, () => row)
    const { supabase } = stub(a => ({ data: a === 0 ? full : [row], error: null }))
    assert.equal((await loadMonthLines(supabase, '2026-10')).length, 1001)
  })

  test('a failed read says so, it does not draw an empty month', async () => {
    const { supabase } = stub(() => ({ data: null, error: { message: 'no' } }))
    await assert.rejects(loadMonthLines(supabase, '2026-10'), /could not be read/)
  })
})

describe('the Bank Statements ID', () => {
  test('it reads as BS and five digits, and grows past that', () => {
    assert.equal(bankLineId(412), 'BS-00412')
    assert.equal(bankLineId(123456), 'BS-123456')
  })

  test('however it is typed, it finds that line and no other', () => {
    for (const t of ['BS-00412', 'bs-412', 'BS412', ' bs00412 ']) assert.equal(matchesBankLineId(412, t), true, t)
    assert.equal(matchesBankLineId(4120, 'BS-412'), false)
    assert.equal(matchesBankLineId(412, '412'), false)
  })

  test('it is on the lists, the credit window and the page search', () => {
    const view = read('BankStatementsView.tsx')
    assert.equal(view.split('<th style={{ width: 92 }}>ID</th>').length - 1, 2)
    assert.equal(view.split('{bankLineId(a.line.statement_no)}').length - 1, 2)
    assert.equal(view.split('matchesBankLineId(a.line.statement_no, q)').length - 1, 2)
    assert.ok(read('bankLineModal.tsx').includes('{bankLineId(line.statement_no)}'))
  })
})

describe('the page', () => {
  const view = read('BankStatementsView.tsx')

  test('the account tabs are gone, and every list says which account', () => {
    assert.ok(!view.includes('aria-label="Account"'))
    assert.equal(view.split('<th style={{ width: 96 }}>Account</th>').length - 1, 3)
    assert.equal(view.split('<td>{BANK_ACCOUNT_LABEL[a.line.account]}</td>').length - 1, 2)
    assert.ok(view.includes('<td>{BANK_ACCOUNT_LABEL[p.payment_mode as BankAccountKey]}</td>'))
  })

  test('the filter narrows all three lists and starts on both', () => {
    assert.ok(view.includes("useState<AccountFilter>('all')"))
    assert.ok(view.includes('l.deposit > 0 && inAccount(l.account, accountFilter)'))
    assert.ok(view.includes('l.withdrawal > 0 && inAccount(l.account, accountFilter)'))
    assert.ok(view.includes('inAccount(p.payment_mode, accountFilter)'))
  })

  test("an account's box pressed again goes back to both", () => {
    assert.ok(view.includes("if (accountFilter === acct) { setAccountFilter('all'); return }"))
  })

  test('the date line gives each account its own last date', () => {
    assert.ok(view.includes('{statementsRunTo(ranges)}'))
  })

  test('an upload comes back to both accounts', () => {
    assert.ok(/onImported=\{\(_acct, m, message\) => \{\n\s+setUploading\(false\)\n\s+setAccountFilter\('all'\)/.test(view))
  })
})
