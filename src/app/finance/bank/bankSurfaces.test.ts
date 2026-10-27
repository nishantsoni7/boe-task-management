// Source pins for Bank Statements: the guarantees that are easy to lose in an
// edit and invisible in a screenshot.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = __dirname
const read = (rel: string) => readFileSync(join(DIR, rel), 'utf8')
const bankFiles = readdirSync(DIR).filter(f => /\.(tsx?)$/.test(f) && !f.endsWith('.test.ts'))
const MIGRATION = readFileSync(
  join(DIR, '..', '..', '..', '..', 'supabase', 'migrations', '20270329000000_finance_bank_statements.sql'),
  'utf8',
)

describe('Bank Statements never decides a payment', () => {
  test('no bank file calls a verification, rejection, clarification, allocation or edit RPC', () => {
    for (const f of bankFiles) {
      const src = read(f)
      for (const rpc of [
        'approve_finance_payment_request', 'reject_finance_payment_request', 'request_finance_payment_clarification',
        'allocate_payment_to_target', 'reverse_payment_allocation', 'edit_payment_request', 'complete_payment_entry',
      ]) {
        assert.ok(!src.includes(rpc), `${f} must not call ${rpc}: linking is a note beside a payment, not a decision on it`)
      }
    }
  })

  test('the only writes are the bank RPCs; no direct table write', () => {
    const allowed = new Set([
      'import_bank_statement',
      'classify_bank_line', 'clear_bank_line_classification',
      'link_bank_debit_to_expense', 'unlink_bank_debit_expense', 'classify_bank_debits',
      // 20270419000000: records the credit as a payment and links it in one transaction (duplicates refused in the database).
      'create_payment_from_bank_line',
      // 20270423000000: adds the named credits to Confirmed Payments (or links one to the payment already carrying its reference).
      'sync_bank_credits',
      // A read: where the payments linked to earlier credits are allocated (for the order suggestion).
      'received_payment_allocation_targets',
    ])
    for (const f of bankFiles) {
      const src = read(f)
      for (const m of src.matchAll(/\.rpc\('([a-z_]+)'/g)) assert.ok(allowed.has(m[1]), `${f} calls unexpected RPC ${m[1]}`)
      assert.ok(!/\.(insert|update|delete|upsert)\(/.test(src), `${f} writes a table directly`)
    }
  })

  test('linking an existing payment to a credit is not done on this page: it is done in Confirmed Payments', () => {
    for (const f of bankFiles) {
      const src = read(f)
      assert.ok(!src.includes('link_bank_line_to_payment'), `${f} must not link a payment by hand`)
      assert.ok(!src.includes('unlink_bank_line_payment'), `${f} must not unlink a payment`)
    }
  })

  test('sync: the page names the credits, never sends an amount, and Not Synced is drawn red', () => {
    const model = read('bankStatementsModel.ts')
    const view = read('BankStatementsView.tsx')
    assert.ok(model.includes("rpc('sync_bank_credits', { p_line_ids: "))
    assert.ok(!/p_amount/.test(model + view))
    assert.ok(view.includes("not_synced: { tone: 'over', label: 'Not Synced' }"))
    assert.ok(view.includes('syncUpload(importId, message)'))
    assert.ok(view.includes('Check sync'))
  })

  test('linking never sends an amount from the browser by default (the database defaults it)', () => {
    assert.ok(!/p_amount/.test(read('bankLineModal.tsx')))
  })
})

describe('Bank Statements is for finance.reconcile only', () => {
  test('the page draws nothing but a refusal without the capability', () => {
    const src = read('BankStatementsView.tsx')
    assert.ok(src.includes('if (!caps.canReconcileBank)'))
    assert.ok(src.indexOf('if (!caps.canReconcileBank)') < src.indexOf('<FinanceStatusCards'))
  })

  test('the sidebar entry is absent, not disabled, without the capability', () => {
    const src = readFileSync(join(DIR, '..', '..', '..', 'components', 'layout', 'FinanceLayout.tsx'), 'utf8')
    assert.ok(/canReconcileBank\s*\r?\n?\s*\? \[/.test(src))
  })

  test('the parse route asks the database before answering and writes nothing', () => {
    const src = readFileSync(join(DIR, '..', '..', 'api', 'finance', 'bank', 'parse', 'route.ts'), 'utf8')
    assert.ok(src.includes("rpc('preview_bank_statement'"))
    assert.ok(!/\.(insert|update|delete|upsert)\(/.test(src))
    assert.ok(src.includes('MAX_BYTES'))
  })
})

describe('the migration', () => {
  test('registers the protected action deny-by-default and closes the tables to client writes', () => {
    assert.ok(MIGRATION.includes("'reconcile'"))
    assert.ok(/default_allowed[\s\S]*false/.test(MIGRATION))
    assert.ok(MIGRATION.includes('revoke all on public.%I from public, anon, authenticated'))
    assert.ok(MIGRATION.includes('grant select on public.%I to authenticated'))
  })

  test('holds no account number', () => {
    assert.ok(!/\b\d{10,}\b/.test(MIGRATION.replace(/20270329000000/g, '')), 'a bank account number must never be committed to this public repository')
  })

  test('every RPC is definer with a fixed search_path and no anon execute', () => {
    const fns = MIGRATION.match(/create or replace function public\.(import_bank_statement|link_bank_line_to_payment|unlink_bank_line_payment|classify_bank_line|clear_bank_line_classification|preview_bank_statement)/g) ?? []
    assert.equal(fns.length, 6)
    assert.equal((MIGRATION.match(/security definer\s*\r?\nset search_path = public, pg_temp/g) ?? []).length >= 7, true)
    assert.ok(MIGRATION.includes('revoke all on function public.import_bank_statement'))
  })
})
