// THE APPROVER'S PAYMENT CHIPS IN ONE CALL (migration 20270818000000, 2026-11-21).
//
// Before: one pi_submission_payment_summary request per PI row (up to 12 at once). Now one
// pi_submissions_payment_summaries request. The migration is a thin wrapper over the single-PI function (no payment
// rule is copied), and the screen falls back to one request per PI where the batch is not on the database.
//
// Run with: npx tsx --test src/lib/orders/piPaymentSummariesBatch.test.ts

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPiPaymentSummaries, type PiPaymentSummary } from '@/lib/finance/piPaymentView'

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20270818000000_pi_payment_summaries_batch.sql'), 'utf8',
).replace(/\r/g, '')

// SQL with its line comments removed, so a rule named in a comment cannot satisfy or break an assertion.
const SQL = MIGRATION.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

const summary = (id: string) => ({ submission_id_marker: id }) as unknown as PiPaymentSummary

type Call = { fn: string; args: Record<string, unknown> }
function client(answer: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message?: string; code?: string } | null }) {
  const calls: Call[] = []
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return answer(fn, args) },
  }
}

describe('loadPiPaymentSummaries', () => {
  test('one call for all the PIs, answers lined up with the ids that were asked', async () => {
    const c = client(() => ({ data: [{ submission_id: 'b', summary: summary('b') }, { submission_id: 'a', summary: summary('a') }], error: null }))
    const out = await loadPiPaymentSummaries(c, ['a', 'b'])
    assert.deepEqual(c.calls.map(x => x.fn), ['pi_submissions_payment_summaries'])
    assert.deepEqual(c.calls[0].args, { p_submission_ids: ['a', 'b'] })
    assert.deepEqual(out, [summary('a'), summary('b')], 'by id, never by the order the rows came back in')
  })

  test('a PI the database returned no row for has no chip, as a refused single read had none', async () => {
    const c = client(() => ({ data: [{ submission_id: 'a', summary: summary('a') }], error: null }))
    assert.deepEqual(await loadPiPaymentSummaries(c, ['a', 'hidden']), [summary('a'), null])
  })

  test('no PIs, no call', async () => {
    const c = client(() => ({ data: [], error: null }))
    assert.deepEqual(await loadPiPaymentSummaries(c, []), [])
    assert.equal(c.calls.length, 0)
  })

  test('a database without the batch (or a failed batch) is asked per PI, exactly as before', async () => {
    const c = client(fn => fn === 'pi_submissions_payment_summaries'
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
      : { data: summary('one'), error: null })
    const out = await loadPiPaymentSummaries(c, ['a', 'b'])
    assert.deepEqual(c.calls.map(x => x.fn), ['pi_submissions_payment_summaries', 'pi_submission_payment_summary', 'pi_submission_payment_summary'])
    assert.deepEqual(c.calls.slice(1).map(x => x.args), [{ p_submission_id: 'a' }, { p_submission_id: 'b' }])
    assert.deepEqual(out, [summary('one'), summary('one')])
  })

  test('an answer that is not a list is not trusted: it falls back too, and a failed single read is still no chip', async () => {
    const c = client(fn => fn === 'pi_submissions_payment_summaries'
      ? { data: { oops: true }, error: null }
      : { data: null, error: { message: 'refused' } })
    assert.deepEqual(await loadPiPaymentSummaries(c, ['a']), [null])
    assert.equal(c.calls.length, 2)
  })
})

describe('the migration', () => {
  test('is a read-only wrapper over the single-PI function: no table, no copied payment rule', () => {
    assert.ok(SQL.includes('public.pi_submission_payment_summary(v_id)'), 'every summary is the single function\'s own answer')
    assert.equal(/\bfrom\s+public\./i.test(SQL), false, 'it reads no table itself')
    assert.equal(/\b(insert|update|delete|alter|drop|truncate)\b/i.test(SQL), false, 'nothing is written')
    assert.equal(/finance_payment|allocat|grand_total|advance_exception/i.test(SQL), false, 'no payment rule is restated here')
  })

  test('runs with the caller\'s own rights, is stable, and keeps a fixed search path', () => {
    assert.match(SQL, /returns table \(submission_id uuid, summary jsonb\)/)
    assert.match(SQL, /\bstable\b/)
    assert.match(SQL, /security invoker/)
    assert.equal(/security definer/i.test(SQL), false)
    assert.match(SQL, /set search_path = public, pg_temp/)
  })

  test('refuses a caller who is not signed in and a call for more than 50 PIs', () => {
    assert.match(SQL, /if auth\.uid\(\) is null then\s+raise exception 'Authentication required' using errcode = '28000'/)
    assert.match(SQL, /array_length\(p_submission_ids, 1\), 0\) > 50 then\s+raise exception 'TOO_MANY_SUBMISSIONS[^']*' using errcode = '22023'/)
  })

  test('swallows ONLY "not a PI you may view" (42501): anything else fails the call so the screen asks per PI', () => {
    assert.match(SQL, /exception when insufficient_privilege then/)
    assert.equal(/when others/i.test(SQL), false)
    assert.equal((SQL.match(/\bexception\b/g) ?? []).length, 3, 'two raised errors and one handler, nothing else')
  })

  test('one answer per distinct id, in the order first given', () => {
    assert.match(SQL, /unnest\(p_submission_ids\) with ordinality as u\(id, ord\)/)
    assert.match(SQL, /group by u\.id/)
    assert.match(SQL, /order by d\.ord/)
  })

  test('is callable by signed-in users only', () => {
    assert.match(SQL, /revoke execute on function public\.pi_submissions_payment_summaries\(uuid\[\]\) from public, anon;/)
    assert.match(SQL, /grant\s+execute on function public\.pi_submissions_payment_summaries\(uuid\[\]\) to authenticated;/)
    assert.equal(/to anon|to public/i.test(SQL), false)
  })

  test('says how to take it back', () => {
    assert.ok(MIGRATION.includes('drop function public.pi_submissions_payment_summaries(uuid[]);'))
  })
})
