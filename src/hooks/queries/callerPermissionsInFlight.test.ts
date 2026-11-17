// The Orders page is built while its guard waits for the permission context (2026-11-18, page speed). A page that
// asks for one module's permissions then must wait for the guard's read, not send its own; and an answer put back
// from the saved copy (invalidated) must never be reused to decide anything.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cachedModulePermissions, callerModulePermissions } from './usePermissionContext'
import type { EffectivePermission } from '@/lib/permissions/types'

const ME = '6507df9f-cdeb-4ebd-849f-8498c165d596'
const VIEW: EffectivePermission[] = [{ actionKey: 'view', allowed: true, source: 'role' } as EffectivePermission]

function rpcCounter() {
  const calls: string[] = []
  const supabase = { rpc: async (name: string) => { calls.push(name); return { data: [], error: null } } } as unknown as SupabaseClient
  return { calls, supabase }
}

describe('a page asking for permissions while the guard is still reading them', () => {
  test('waits for the guard\'s read and sends none of its own', async () => {
    const qc = new QueryClient()
    let finish: (v: unknown) => void = () => {}
    const guard = new QueryObserver(qc, {
      queryKey: ['permission-context', ME],
      queryFn: () => new Promise(r => { finish = r }),
    })
    const stop = guard.subscribe(() => {})
    await new Promise(r => setTimeout(r, 10))
    const { calls, supabase } = rpcCounter()
    const asked = callerModulePermissions(qc, supabase, ME, 'orders')
    finish({ profile: { id: ME }, permissionsByModule: new Map([['orders', VIEW]]) })
    assert.deepEqual(await asked, VIEW)
    assert.equal(calls.length, 0, 'no second request')
    stop()
  })

  test('with nothing on its way and nothing fresh, it asks the database as before', async () => {
    const qc = new QueryClient()
    const { calls, supabase } = rpcCounter()
    await callerModulePermissions(qc, supabase, ME, 'orders')
    assert.deepEqual(calls, ['resolve_effective_permissions'])
  })

  test('an invalidated answer (a saved copy put back) is never reused', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['permission-context', ME], { profile: { id: ME }, permissionsByModule: new Map([['orders', VIEW]]) })
    assert.deepEqual(cachedModulePermissions(qc, ME, 'orders'), VIEW, 'a fresh answer is reused')
    await qc.invalidateQueries({ queryKey: ['permission-context', ME], refetchType: 'none' })
    assert.equal(cachedModulePermissions(qc, ME, 'orders'), null)
  })
})
