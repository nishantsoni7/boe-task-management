// THE ORDERS DASHBOARD'S FIRST BURST OF READS (2026-10-22).
//
// Measured on the live site: a request that waits beside others finishes about 70 ms later for each
// one. The dashboard opened with nine reads at once (profile, permissions, the three dashboard RPCs,
// the PI Drafts count and three handoff counts). It now opens with five, and the links to other
// queues at the foot of the page are read after it has drawn: PI Drafts, and ONE read of the
// undecided operations handoffs in place of three head counts. Nothing about who sees what changed.
//
// Run with: npx tsx --test "src/lib/orders/ordersDashboardFewerReads.test.ts"

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE = readFileSync(join(__dirname, '..', '..', 'app', 'orders', 'page.tsx'), 'utf8').replace(/\r/g, '')
const LOAD = PAGE.slice(PAGE.indexOf('const loadData = async'), PAGE.indexOf('const loadQueueCounts = async'))
const QUEUES = PAGE.slice(PAGE.indexOf('const loadQueueCounts = async'), PAGE.indexOf('useEffect(() => {\n    const init'))

describe('the first group', () => {
  test('holds only the three dashboard reads', () => {
    const group = LOAD.slice(LOAD.indexOf('await Promise.all(['), LOAD.indexOf('if (ticket !== latest.current) return'))
    assert.equal((group.match(/supabase\.rpc\(/g) ?? []).length, 3)
    assert.equal(/\.from\(/.test(group), false, 'no table read is left in the first group')
  })

  test('starts the queue links after the page state is set, without waiting for them', () => {
    assert.ok(LOAD.indexOf('setSummary(parsed.ok') < LOAD.indexOf('void loadQueueCounts(viewerId, ticket)'))
  })
})

describe('the queue links', () => {
  test('are one PI Drafts count and ONE handoffs read, with the three numbers taken from it', () => {
    assert.equal((QUEUES.match(/\.from\('order_operations_handoffs'\)/g) ?? []).length, 1)
    assert.match(QUEUES, /\.in\('status', \['awaiting', 'clarification_needed'\]\)\.is\('superseded_at', null\)/)
    assert.match(QUEUES, /h\.status === 'awaiting' && h\.assigned_to === viewerId/)
    assert.match(QUEUES, /h\.status === 'awaiting' && h\.assigned_to === null/)
    assert.match(QUEUES, /h\.status === 'clarification_needed'/)
    assert.match(QUEUES, /\.in\('status', PI_DRAFT_LIST_STATUSES as unknown as string\[\]\)/)
  })

  test('a refused handoffs read leaves its links absent, never a false "nothing waits"', () => {
    assert.match(QUEUES, /const live = handoffsRes\.error \? null :/)
    assert.equal((QUEUES.match(/: undefined,/g) ?? []).length, 3)
  })

  test('a newer read is never overwritten by an older one', () => {
    assert.match(QUEUES, /if \(ticket !== latest\.current\) return/)
  })
})
