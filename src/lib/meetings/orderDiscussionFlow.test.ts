/**
 * The Order discussion flow, read from its source.
 *
 * Two promises live in the ORDER of calls rather than in any one function, and
 * a harmless-looking refactor could break either while every screen still
 * works:
 *
 *   1. An image is recorded only AFTER its upload succeeded, and an image whose
 *      recording failed has its stray object removed — so no row ever points at
 *      nothing and nothing stored is shown as evidence.
 *   2. Earlier history is read in a bounded number of batched queries, never one
 *      query per meeting or per Order, and nothing on this screen writes to an
 *      earlier meeting.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/orderDiscussionFlow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const DISCUSSION = read('src/components/meetings/OrderDiscussion.tsx')
const SCREEN     = read('src/app/meetings/[id]/MeetingWorkScreen.tsx')
const BOARD      = read('src/components/meetings/MeetingBoard.tsx')

describe('saving today’s update and evidence', () => {
  test('the update is saved before any image is uploaded, so a refused update uploads nothing', () => {
    const update = DISCUSSION.indexOf("rpc('save_meeting_order_update'")
    const upload = DISCUSSION.indexOf('bucket.upload(')
    assert.ok(update > -1 && upload > update)
  })

  test('an image is recorded only after its upload, and removed if recording fails', () => {
    const upload = DISCUSSION.indexOf('bucket.upload(')
    const record = DISCUSSION.indexOf("rpc('add_meeting_order_evidence'")
    const cleanup = DISCUSSION.indexOf('bucket.remove([path])')
    assert.ok(upload > -1 && record > upload && cleanup > record)
    assert.match(DISCUSSION, /upsert: false/, 'an existing object is never overwritten')
  })

  test('today is written only to THIS meeting’s Order row', () => {
    const rpcs = [...DISCUSSION.matchAll(/rpc\('([a-z_]+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(rpcs, ['add_meeting_order_evidence', 'save_meeting_order_update'])
    assert.equal((DISCUSSION.match(/p_order_id: order\.id/g) ?? []).length, 2)
  })
})

describe('reading earlier meetings', () => {
  test('one indexed lookup by Order key, then batched reads by meeting_order id', () => {
    assert.equal((DISCUSSION.match(/\.eq\('order_number_key', key\)/g) ?? []).length, 1)
    assert.match(DISCUSSION, /\.from\('meeting_update_history'\)[\s\S]{0,200}\.in\('meeting_order_id', meetingOrderIds\)/)
    assert.match(DISCUSSION, /\.from\('meeting_order_evidence'\)[\s\S]{0,200}\.in\('meeting_order_id', meetingOrderIds\)/)
  })

  test('only the most recent earlier meetings are read up front', () => {
    assert.match(DISCUSSION, /const INITIAL_EARLIER_MEETINGS = 3/)
    assert.match(DISCUSSION, /earlier\.slice\(0, INITIAL_EARLIER_MEETINGS\)/)
  })

  test('the board reads evidence and earlier meetings once for the whole meeting', () => {
    assert.match(SCREEN, /fetchEvidenceRows\(supabase, orderIds\)/)
    assert.match(SCREEN, /\.in\('order_number_key', orderKeys\)/)
  })

  test('the board itself reads and writes nothing', () => {
    assert.ok(!/supabase|\.rpc\(|\.from\(/.test(BOARD))
  })
})
