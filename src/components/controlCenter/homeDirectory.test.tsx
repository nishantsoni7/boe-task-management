import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { highlightParts } from './HomeDirectory'

// The matching words in a label are marked on Home's search results. The pieces must always put the label
// back together exactly, so a highlight can never drop, repeat or reorder a character of what is shown.
const joined = (label: string, q: string) => highlightParts(label, q).map(p => p.text).join('')

describe('Home search highlighting', () => {
  test('the matching word is marked, the rest is not', () => {
    assert.deepEqual(highlightParts('Order visibility', 'order'), [
      { text: 'Order', hit: true },
      { text: ' visibility', hit: false },
    ])
  })

  test('several words are each marked, in label order, whatever order they were typed in', () => {
    assert.deepEqual(highlightParts('Day Close & Scoreboard', 'score day'), [
      { text: 'Day', hit: true },
      { text: ' Close & ', hit: false },
      { text: 'Score', hit: true },
      { text: 'board', hit: false },
    ])
  })

  test('no match, an empty query, and overlapping words all return the whole label unbroken', () => {
    assert.deepEqual(highlightParts('Employees', 'zzz'), [{ text: 'Employees', hit: false }])
    assert.deepEqual(highlightParts('Employees', ''), [{ text: 'Employees', hit: false }])
    for (const q of ['emp employ', 'ploy ploye', 'e', 'ees employees', '  Employees  ']) {
      assert.equal(joined('Employees', q), 'Employees', q)
    }
    assert.equal(joined('Day Close & Scoreboard', 'amp & close'), 'Day Close & Scoreboard')
  })
})
