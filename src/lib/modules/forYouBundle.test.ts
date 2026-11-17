// The For you column's reads in one call (forYouBundle.ts + 20270730000000): each caller gets what its own read
// would have given, and anything the bundle cannot answer is asked the old way.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUNDLE_PARTS, bundledRead, type BundleAnswer, type Deps } from './forYouBundle'
import { OPEN_HANDOVER_STATUSES } from '@/lib/finance/handover'

const SQL = readFileSync('supabase/migrations/20270730000000_for_you_bundle.sql', 'utf8')

/** Deps whose window is flushed by hand, recording every bundle call. */
function harness(answer: (args: Parameters<Deps['rpc']>[0]) => BundleAnswer | Promise<BundleAnswer>) {
  const calls: Parameters<Deps['rpc']>[0][] = []
  let run: (() => void) | null = null
  const deps: Deps = { rpc: async args => { calls.push(args); return answer(args) }, windowMs: 10, schedule: r => { run = r } }
  return { deps, calls, flush: () => { const r = run; run = null; r?.() } }
}
const direct = (data: unknown, counter?: { n: number }) => () => { if (counter) counter.n++; return Promise.resolve({ data, error: null }) }

describe('for you bundle (page speed, 17 Nov 2026)', () => {
  test('parts asked together travel as ONE call and each gets its own answer', async () => {
    const h = harness(() => ({ data: { modes: { data: [{ item_key: 'x', mode: 'off' }] }, unclosed: { data: { scope: 'none' } }, choices: { data: null } }, error: null }))
    const n = { n: 0 }
    const a = bundledRead('modes', direct('old', n), {}, h.deps)
    const b = bundledRead('unclosed', direct('old', n), {}, h.deps)
    const c = bundledRead('choices', direct('old', n), { choicesUser: 'u1' }, h.deps)
    h.flush()
    assert.deepEqual(await a, { data: [{ item_key: 'x', mode: 'off' }], error: null })
    assert.deepEqual(await b, { data: { scope: 'none' }, error: null })
    // No row of choices is null, exactly what maybeSingle answers.
    assert.deepEqual(await c, { data: null, error: null })
    assert.equal(h.calls.length, 1)
    assert.equal(n.n, 0)
    assert.deepEqual(h.calls[0], { p_parts: ['modes', 'unclosed', 'choices'], p_choices_user: 'u1', p_handover_statuses: null })
  })

  test('one part alone makes its own read (another screen reading cash on its way)', async () => {
    const h = harness(() => { throw new Error('must not be called') })
    const p = bundledRead('unclosed', direct('own'), {}, h.deps)
    h.flush()
    assert.deepEqual(await p, { data: 'own', error: null })
    assert.equal(h.calls.length, 0)
  })

  test('the function missing (before the migration is applied) or failing: every caller reads the old way', async () => {
    for (const answer of [() => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }), () => { throw new Error('network') }]) {
      const h = harness(answer as () => BundleAnswer)
      const a = bundledRead('modes', direct('m'), {}, h.deps)
      const b = bundledRead('handovers', direct('h'), { handoverStatuses: ['pending'] }, h.deps)
      h.flush()
      assert.deepEqual([await a, await b], [{ data: 'm', error: null }, { data: 'h', error: null }])
    }
  })

  test('a part left out of the answer (it raised in the database) is asked the old way, so its error shows as before', async () => {
    const h = harness(() => ({ data: { modes: { data: [] } }, error: null }))
    const failing = () => Promise.resolve({ data: null, error: { message: 'Not allowed' } })
    const a = bundledRead('modes', direct('old'), {}, h.deps)
    const b = bundledRead('flagged', failing, {}, h.deps)
    h.flush()
    assert.deepEqual(await a, { data: [], error: null })
    assert.deepEqual(await b, { data: null, error: { message: 'Not allowed' } })
  })

  test('the same part asked with other arguments goes alone; the first asker decides the bundle', async () => {
    const h = harness(() => ({ data: { choices: { data: { hidden_items: ['a'] } }, modes: { data: [] } }, error: null }))
    const a = bundledRead('choices', direct('x'), { choicesUser: 'u1' }, h.deps)
    const b = bundledRead('choices', direct('someone else'), { choicesUser: 'u2' }, h.deps)
    const c = bundledRead('modes', direct('x'), {}, h.deps)
    h.flush()
    assert.deepEqual(await a, { data: { hidden_items: ['a'] }, error: null })
    assert.deepEqual(await b, { data: 'someone else', error: null })
    assert.deepEqual(await c, { data: [], error: null })
    assert.equal(h.calls[0].p_choices_user, 'u1')
  })

  test('the migration answers exactly the parts the browser asks, as the caller, closed to anon', () => {
    for (const part of BUNDLE_PARTS) assert.match(SQL, new RegExp(`v_part = '${part}'`), part)
    assert.match(SQL, /security invoker/)
    assert.doesNotMatch(SQL, /security definer/)
    assert.match(SQL, /set search_path = public, pg_temp/)
    assert.match(SQL, /revoke all on function public\.for_you_bundle\(text\[\], uuid, text\[\]\) from public, anon/)
    assert.match(SQL, /grant execute on function public\.for_you_bundle\(text\[\], uuid, text\[\]\) to authenticated/)
    // A part that raises is left out, never fails the others.
    assert.match(SQL, /exception when others then/)
    // The open-handover read takes the browser's statuses and the same four other arguments as useOpenHandovers.
    assert.match(SQL, /finance_handover_list\(p_handover_statuses, false, 100, 0, null\)/)
    const hook = readFileSync('src/hooks/queries/useHandovers.ts', 'utf8')
    assert.match(hook, /p_only_mine: false,\s+p_limit: 100,\s+p_offset: 0,\s+p_id: null,\s+\}\), \{ handoverStatuses: OPEN_HANDOVER_STATUSES \}\)/)
    assert.ok(OPEN_HANDOVER_STATUSES.length > 0)
  })
})
