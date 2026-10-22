// PI DRAFTS IN ONE ROUND TRIP (20270404000000).
//
// The list used to read its rows and then, in a second round trip, the advance percentage of
// those ids. The percentage is now a column of the same select (a PostgREST computed column
// that calls the batch function), and the page falls back to the two-step read against a
// database that does not have it yet. These pin both halves and the rule that the figure is
// still the one pi_submissions_advance_percent() computes.
//
// Run with: npx tsx --test "src/lib/orders/piDraftsOneTrip.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PI_DRAFT_LIST_COLUMNS,
  PI_DRAFT_LIST_COLUMNS_WITH_PERCENT,
  isMissingAttachedPercent,
  percentOfRow,
} from './draftsView'

const ROOT = join(__dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')
const SQL = read('supabase/migrations/20270404000000_order_submission_attached_percent_computed_column.sql')
const PAGE = read('src/app/orders/drafts/page.tsx')

describe('the list asks for the percentage in the same select', () => {
  test('the columns are the old list plus exactly one name', () => {
    assert.equal(PI_DRAFT_LIST_COLUMNS_WITH_PERCENT, `${PI_DRAFT_LIST_COLUMNS}, attached_percent`)
    assert.equal(PI_DRAFT_LIST_COLUMNS.includes('attached_percent'), false, 'the old list is untouched')
  })

  test('a database without the column is recognised, and nothing else is mistaken for it', () => {
    assert.equal(isMissingAttachedPercent({ code: '42703', message: 'column order_submissions.attached_percent does not exist' }), true)
    assert.equal(isMissingAttachedPercent({ code: 'PGRST204', message: "Could not find the 'attached_percent' column of 'order_submissions'" }), true)
    assert.equal(isMissingAttachedPercent({ code: '42501', message: 'permission denied for table order_submissions' }), false)
    assert.equal(isMissingAttachedPercent({ code: '42703', message: 'column order_submissions.something_else does not exist' }), false)
    assert.equal(isMissingAttachedPercent(null), false)
  })

  test('a missing figure stays missing: it is never read as 0%', () => {
    assert.equal(percentOfRow({}), null)
    assert.equal(percentOfRow({ attached_percent: null }), null)
    assert.equal(percentOfRow({ attached_percent: 0 }), 0)
    assert.equal(percentOfRow({ attached_percent: '42.24' }), '42.24')
  })
})

describe('the page', () => {
  test('the first read carries the percentage; the second read happens only for a database without it', () => {
    assert.match(PAGE, /select\(withPercent \? PI_DRAFT_LIST_COLUMNS_WITH_PERCENT : PI_DRAFT_LIST_COLUMNS\)/)
    assert.match(PAGE, /if \(isMissingAttachedPercent\(result\.error\)\) \{\s+percentsWithRows = false\s+result = await draftsQuery\(false\)/)
    assert.match(PAGE, /if \(percentsWithRows\) \{\s+for \(const r of rows\) advance\.set\(r\.id, percentOfRow\(r\)\)\s+\} else if \(rows\.length > 0\) \{/)
  })

  test('the batch call is only the fallback, after the rows are in hand', () => {
    assert.equal((PAGE.match(/rpc\('pi_submissions_advance_percent'/g) ?? []).length, 1)
    assert.ok(PAGE.indexOf("rpc('pi_submissions_advance_percent'") > PAGE.indexOf('percentsWithRows = false'))
  })
})

describe('the migration (20270404000000)', () => {
  test('it is a function of the row that calls the batch function, not a third copy of the rule', () => {
    assert.match(SQL, /create or replace function public\.attached_percent\(p_submission public\.order_submissions\)\s+returns numeric/)
    assert.match(SQL, /from public\.pi_submissions_advance_percent\(array\[p_submission\.id\]\) p/)
    assert.equal(/finance_payment_allocations/.test(SQL.replace(/--.*$/gm, '')), false, 'no second copy of the allocation rule')
  })

  test('it is closed to anon, open to signed-in users, and pins its search_path', () => {
    assert.match(SQL, /revoke execute on function public\.attached_percent\(public\.order_submissions\) from public, anon;/)
    assert.match(SQL, /grant\s+execute on function public\.attached_percent\(public\.order_submissions\) to authenticated;/)
    assert.match(SQL, /security definer\s+set search_path = public, pg_temp/)
  })

  test('it changes no table, column, policy or trigger and writes nothing', () => {
    const code = SQL.replace(/--.*$/gm, '')
    assert.equal(/create\s+table|alter\s+table|create\s+policy|create\s+(or\s+replace\s+)?trigger|insert\s+into|update\s+public\.|delete\s+from/i.test(code), false)
  })
})
