/**
 * A CANCELLED ORDER KEEPS ITS NUMBER FOR GOOD (owner, 2026-10-31).
 *
 * change_confirmed_order_number() and delete_confirmed_order() have no status
 * check, so both routes read the Order's status first. These tests run that
 * read against a fake client; the routes' own order of work is pinned in
 * orderNumberChange.test.ts and orderDeletion.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/orders/cancelledOrderLock.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readCancelledOrderLock } from './cancelledOrderLock'

function clientAnswering(result: { data: { status?: string | null } | null; error: unknown }) {
  const asked: string[] = []
  const client = {
    from: (table: string) => {
      asked.push(table)
      return {
        select: (columns: string) => {
          asked.push(columns)
          return {
            eq: (column: string, value: string) => {
              asked.push(`${column}=${value}`)
              return { maybeSingle: async () => result }
            },
          }
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, asked }
}

describe('reading the lock', () => {
  test('a cancelled Order is locked', async () => {
    const { client } = clientAnswering({ data: { status: 'cancelled' }, error: null })
    assert.equal(await readCancelledOrderLock(client, 'order-1'), 'cancelled')
  })

  test('every other status is open', async () => {
    for (const status of ['running', 'on_hold', 'ready_for_dispatch', 'dispatched']) {
      const { client } = clientAnswering({ data: { status }, error: null })
      assert.equal(await readCancelledOrderLock(client, 'order-1'), 'open', status)
    }
  })

  test('no row is open: the database then answers for a missing or forbidden Order', async () => {
    const { client } = clientAnswering({ data: null, error: null })
    assert.equal(await readCancelledOrderLock(client, 'order-1'), 'open')
  })

  test('a failed read is unknown, never open', async () => {
    const { client } = clientAnswering({ data: null, error: { message: 'timeout' } })
    assert.equal(await readCancelledOrderLock(client, 'order-1'), 'unknown')
  })

  test('it reads only the status of this one Order', async () => {
    const { client, asked } = clientAnswering({ data: { status: 'running' }, error: null })
    await readCancelledOrderLock(client, 'order-1')
    assert.deepEqual(asked, ['orders', 'status', 'id=order-1'])
  })
})
