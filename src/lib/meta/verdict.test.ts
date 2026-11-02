/**
 * How an ad set is judged. The numbers are the owner's proposed defaults; made-up amounts are used here.
 *
 * Run: npx tsx --test src/lib/meta/verdict.test.ts
 */
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { judge, LOSING_OVER_TARGET, MIN_CHATS, MIN_SPEND_PAISE } from './verdict'

const rs = (n: number) => n * 100

describe('judge', () => {
  test('nothing spent is no data, whatever else is true', () => {
    assert.equal(judge({ spendPaise: 0, chats: 0, targetPaise: rs(100) }), 'no_data')
    assert.equal(judge({ spendPaise: 0, chats: null, targetPaise: null }), 'no_data')
  })

  test('a goal with no result count gets no verdict', () => {
    assert.equal(judge({ spendPaise: rs(5000), chats: null, targetPaise: rs(100) }), 'other_goal')
  })

  test('under 20 chats and under Rs 3,000 is too early, target or not', () => {
    assert.equal(MIN_CHATS, 20)
    assert.equal(MIN_SPEND_PAISE, rs(3000))
    assert.equal(judge({ spendPaise: rs(1500), chats: 4, targetPaise: rs(100) }), 'too_early')
    assert.equal(judge({ spendPaise: rs(2999), chats: 19, targetPaise: null }), 'too_early')
  })

  test('either 20 chats or Rs 3,000 is enough to judge', () => {
    assert.notEqual(judge({ spendPaise: rs(500), chats: 20, targetPaise: null }), 'too_early')
    assert.notEqual(judge({ spendPaise: rs(3000), chats: 2, targetPaise: null }), 'too_early')
  })

  test('with no target an ad set can only be Watch or Too early', () => {
    assert.equal(judge({ spendPaise: rs(4000), chats: 50, targetPaise: null }), 'watch')
    assert.equal(judge({ spendPaise: rs(40000), chats: 1, targetPaise: null }), 'watch')
  })

  test('at or under the target is Winning', () => {
    assert.equal(judge({ spendPaise: rs(4000), chats: 40, targetPaise: rs(100) }), 'winning')
    assert.equal(judge({ spendPaise: rs(4000), chats: 50, targetPaise: rs(100) }), 'winning')
  })

  test('up to half as much again over the target is Watch, more than that is Losing', () => {
    assert.equal(LOSING_OVER_TARGET, 1.5)
    assert.equal(judge({ spendPaise: rs(6000), chats: 40, targetPaise: rs(100) }), 'watch') // 150 a chat
    assert.equal(judge({ spendPaise: rs(6040), chats: 40, targetPaise: rs(100) }), 'losing') // 151 a chat
  })

  test('Rs 3,000 spent with no chat at all is Losing once a target is set', () => {
    assert.equal(judge({ spendPaise: rs(3000), chats: 0, targetPaise: rs(100) }), 'losing')
    assert.equal(judge({ spendPaise: rs(3000), chats: 0, targetPaise: null }), 'watch')
  })
})
