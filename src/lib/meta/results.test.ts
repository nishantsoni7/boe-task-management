/**
 * What counts as a result. Only a goal with a confirmed mapping has one; the rest are "another goal" on screen.
 *
 * Run: npx tsx --test src/lib/meta/results.test.ts
 */
import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { CHAT_ACTION, hasResultMapping, resultCount } from './results'

describe('results', () => {
  test('a conversations ad set counts the chats started, and nothing else Meta lists', () => {
    const actions = [
      { action_type: 'link_click', value: '40' },
      { action_type: CHAT_ACTION, value: '3' },
      { action_type: 'post_engagement', value: '99' },
    ]
    assert.equal(resultCount('CONVERSATIONS', actions), 3)
  })

  test('a day with no chat action is zero chats, not unknown', () => {
    assert.equal(resultCount('CONVERSATIONS', []), 0)
    assert.equal(resultCount('CONVERSATIONS', [{ action_type: 'link_click', value: '5' }]), 0)
  })

  test('a goal with no confirmed mapping has no result at all', () => {
    assert.equal(hasResultMapping('CONVERSATIONS'), true)
    assert.equal(hasResultMapping('PROFILE_VISIT'), false)
    assert.equal(resultCount('PROFILE_VISIT', [{ action_type: CHAT_ACTION, value: '9' }]), null)
    assert.equal(resultCount('', []), null)
  })

  test('a value that is not a number counts as nothing', () => {
    assert.equal(resultCount('CONVERSATIONS', [{ action_type: CHAT_ACTION, value: 'x' }, { action_type: CHAT_ACTION, value: '2' }]), 2)
  })
})
