/**
 * THE THREE SIDEBAR BADGES IN ONE CALL (2026-11-19, page speed).
 * task_nav_counts (20270810000000) must count exactly what the three head-only reads in DashboardLayout counted,
 * under the caller's own row-level security, and the sidebar must fall back to those reads when it cannot use it.
 *
 * Run: npx tsx --test src/lib/tasks/navCounts.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchNavCounts, NO_NAV_COUNTS } from './navCounts'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SQL = read('supabase/migrations/20270810000000_task_nav_counts.sql').replace(/^\s*--.*$/gm, '')
const LAYOUT = codeOf(read('src/components/layout/DashboardLayout.tsx'))

const UID = '6507df9f-cdeb-4ebd-849f-8498c165d596'

type Q = {
  select(cols: string, opts: unknown): Q
  eq(col: string, v: unknown): Q
  neq(col: string, v: unknown): Q
  in(col: string, v: unknown): Q
  then(resolve: (v: { count: number }) => void): void
}

/** A client that records every request it is asked to make. */
function fakeClient(opts: { rpc?: { data?: unknown; error?: unknown } | 'throws-missing'; counts?: number[] }) {
  const calls: string[] = []
  const reads: string[][] = []
  let next = 0
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push(`rpc:${name}:${JSON.stringify(args)}`)
      if (opts.rpc === undefined || opts.rpc === 'throws-missing') return { data: null, error: { message: 'function not found' } }
      return { data: opts.rpc.data ?? null, error: opts.rpc.error ?? null }
    },
    from: (table: string) => {
      const steps: string[] = [`from:${table}`]
      calls.push(`from:${table}`)
      const q: Q = {
        select: (cols, o) => { steps.push(`select:${cols}:${JSON.stringify(o)}`); return q },
        eq: (c, v) => { steps.push(`eq:${c}:${v}`); return q },
        neq: (c, v) => { steps.push(`neq:${c}:${v}`); return q },
        in: (c, v) => { steps.push(`in:${c}:${JSON.stringify(v)}`); return q },
        then: resolve => { reads.push(steps); resolve({ count: opts.counts?.[next++] ?? 0 }) },
      }
      return q
    },
  }
  return { client: client as unknown as SupabaseClient, calls, reads }
}

describe('one call when the function answers', () => {
  test('one rpc, no table read, and the three numbers come back as the sidebar badges', async () => {
    const { client, calls, reads } = fakeClient({ rpc: { data: [{ my_active: 13, assigned_by_me_active: 8, quotation_active: 3 }] } })
    const out = await fetchNavCounts(client, UID)
    assert.deepEqual(out, { myActive: 13, assignedByMeActive: 8, quotationActive: 3 })
    assert.deepEqual(calls, [`rpc:task_nav_counts:${JSON.stringify({ p_user: UID })}`])
    assert.equal(reads.length, 0)
  })

  test('a single object answer (not an array) is read too, and zeros are real zeros', async () => {
    const { client } = fakeClient({ rpc: { data: { my_active: 0, assigned_by_me_active: 0, quotation_active: 2 } } })
    assert.deepEqual(await fetchNavCounts(client, UID), { myActive: 0, assignedByMeActive: 0, quotationActive: 2 })
  })
})

describe('the three original reads still answer when the function cannot be used', () => {
  const EXPECTED_READS = [
    // My Tasks
    [`eq:assigned_to:${UID}`, 'in:status:["pending","started","working"]', 'neq:task_type:quotation_request'],
    // Assigned By Me
    [`eq:created_by:${UID}`, `neq:assigned_to:${UID}`, 'neq:status:completed', 'neq:status:cancelled'],
    // Quotation Requests
    [`eq:assigned_to:${UID}`, 'eq:task_type:quotation_request', 'neq:status:completed', 'neq:status:cancelled'],
  ]

  async function fallbackFor(rpc: Parameters<typeof fakeClient>[0]['rpc']) {
    const { client, calls, reads } = fakeClient({ rpc, counts: [5, 6, 7] })
    const out = await fetchNavCounts(client, UID)
    assert.deepEqual(out, { myActive: 5, assignedByMeActive: 6, quotationActive: 7 })
    assert.equal(calls.filter(c => c.startsWith('rpc:')).length, 1, 'the function is tried exactly once')
    assert.equal(reads.length, 3)
    // Every read is a head-only count of tasks, with exactly the filters the function copies.
    reads.forEach((steps, i) => {
      assert.deepEqual(steps.slice(0, 2), ['from:tasks', `select:id:${JSON.stringify({ count: 'exact', head: true })}`])
      assert.deepEqual(steps.slice(2), EXPECTED_READS[i], `read ${i + 1}`)
    })
  }

  test('an error from the function (missing, refused) falls back', async () => {
    await fallbackFor({ error: { message: 'Could not find the function public.task_nav_counts' } })
    await fallbackFor('throws-missing')
  })

  test('an empty answer, or numbers that are negative or not numbers, are not trusted', async () => {
    await fallbackFor({ data: null })
    await fallbackFor({ data: [] })
    await fallbackFor({ data: [{ my_active: -1, assigned_by_me_active: 0, quotation_active: 0 }] })
    await fallbackFor({ data: [{ my_active: 'x', assigned_by_me_active: 0, quotation_active: 0 }] })
    await fallbackFor({ data: [{ my_active: 1, assigned_by_me_active: 2 }] })
  })
})

describe('no identity, no request', () => {
  test('an absent or non-UUID id gives zeros and sends nothing', async () => {
    for (const id of [null, undefined, '', 'seed-user-1']) {
      const { client, calls } = fakeClient({})
      assert.deepEqual(await fetchNavCounts(client, id), NO_NAV_COUNTS)
      assert.deepEqual(calls, [])
    }
  })
})

describe('the sidebar', () => {
  test('asks fetchNavCounts, and no longer holds the three reads itself', () => {
    assert.ok(LAYOUT.includes('queryFn: () => fetchNavCounts(supabase, effectiveNavUserId)'))
    assert.equal(/head: true/.test(LAYOUT), false)
    assert.ok(LAYOUT.includes("queryKey: ['nav-counts', effectiveNavUserId]"), 'the key every task mutation invalidates is unchanged')
  })
})

describe('the function (20270810000000)', () => {
  test('it counts the three rules the three reads counted', () => {
    assert.match(SQL, /returns table \(my_active bigint, assigned_by_me_active bigint, quotation_active bigint\)/)
    assert.match(SQL, /t\.assigned_to = p_user\s+and t\.status in \('pending', 'started', 'working'\)\s+and t\.task_type <> 'quotation_request'/)
    assert.match(SQL, /t\.created_by = p_user\s+and t\.assigned_to <> p_user\s+and t\.status <> 'completed'\s+and t\.status <> 'cancelled'/)
    assert.match(SQL, /t\.assigned_to = p_user\s+and t\.task_type = 'quotation_request'\s+and t\.status <> 'completed'\s+and t\.status <> 'cancelled'/)
    assert.match(SQL, /where t\.assigned_to = p_user or t\.created_by = p_user/)
  })

  test('it reads as the caller (row-level security decides), changes nothing, and anon cannot run it', () => {
    assert.match(SQL, /security invoker/)
    assert.equal(/security definer/i.test(SQL), false)
    assert.match(SQL, /\bstable\b/)
    assert.equal(/\b(insert|update|delete|alter table|drop table|create table)\b/i.test(SQL.replace(/raise exception[^;]*;/g, '')), false)
    assert.match(SQL, /revoke all on function public\.task_nav_counts\(uuid\) from public, anon/)
    assert.match(SQL, /grant execute on function public\.task_nav_counts\(uuid\) to authenticated/)
    assert.match(SQL, /set search_path = public/)
  })

  test('the rpc name and argument the helper sends are the function\'s own', () => {
    const helper = codeOf(read('src/lib/tasks/navCounts.ts'))
    assert.ok(helper.includes("supabase.rpc('task_nav_counts', { p_user: uid })"))
    assert.match(SQL, /create or replace function public\.task_nav_counts\(p_user uuid\)/)
  })
})
