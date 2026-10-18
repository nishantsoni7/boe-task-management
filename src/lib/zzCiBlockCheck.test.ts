import { test } from 'node:test'
import assert from 'node:assert/strict'

// THROWAWAY: proves a red CI run blocks the merge button. Never merge.
test('deliberate failure to prove the required check blocks merging', () => {
  assert.equal(1, 2)
})
