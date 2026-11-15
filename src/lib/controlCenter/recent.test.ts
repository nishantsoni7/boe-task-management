import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { recentSectionIds, rememberSection } from './recent'

// A stand-in for sessionStorage that can also refuse, as a blocked or private window does.
function memory(initial?: string) {
  let value: string | null = initial ?? null
  return {
    getItem: () => value,
    setItem: (_k: string, v: string) => { value = v },
    peek: () => value,
  }
}

describe('recent Control Center screens', () => {
  test('newest first, each once, and only the last four are kept', () => {
    const store = memory()
    for (const id of ['employees', 'departments', 'by-person', 'authorities', 'employees', 'numbering']) rememberSection(id, store)
    assert.deepEqual(recentSectionIds(store), ['numbering', 'employees', 'authorities', 'by-person'])
  })

  test('nothing stored, or something unreadable, is "nothing recent", never an error', () => {
    assert.deepEqual(recentSectionIds(memory()), [])
    assert.deepEqual(recentSectionIds(memory('not json')), [])
    assert.deepEqual(recentSectionIds(memory('{"a":1}')), [])
    assert.deepEqual(recentSectionIds(memory('[1,"a",null]')), ['a'])
    assert.deepEqual(recentSectionIds(null), [])
  })

  test('a store that refuses leaves the screen working', () => {
    const refusing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    assert.doesNotThrow(() => rememberSection('employees', refusing))
    assert.deepEqual(recentSectionIds(refusing), [])
    assert.doesNotThrow(() => rememberSection('employees', null))
  })
})
