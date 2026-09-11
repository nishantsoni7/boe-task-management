import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { safeReturnPath } from './safeReturnPath'

const ORIGIN = 'https://boe-task-management.vercel.app'

describe('safeReturnPath', () => {
  test('accepts ordinary same-origin relative paths unchanged', () => {
    assert.equal(safeReturnPath('/modules', ORIGIN), '/modules')
    assert.equal(
      safeReturnPath('/attendance?month=2026-09', ORIGIN),
      '/attendance?month=2026-09',
    )
  })

  test('accepts the maximum supported length', () => {
    const value = `/${'a'.repeat(2047)}`
    assert.equal(value.length, 2048)
    assert.equal(safeReturnPath(value, ORIGIN), value)
  })

  test('rejects over-long values', () => {
    const value = `/${'a'.repeat(2048)}`
    assert.equal(value.length, 2049)
    assert.equal(safeReturnPath(value, ORIGIN), null)
  })

  test('rejects absolute and scheme-based URLs', () => {
    for (const value of [
      'https://evil.com',
      'http://evil.com',
      'javascript:alert(1)',
      'data:text/html,evil',
    ]) {
      assert.equal(safeReturnPath(value, ORIGIN), null, value)
    }
  })

  test('rejects protocol-relative paths', () => {
    for (const value of ['//evil.com', '///evil.com']) {
      assert.equal(safeReturnPath(value, ORIGIN), null, value)
    }
  })

  test('rejects browser-normalized backslash forms', () => {
    for (const value of [
      '/\\evil.com',
      '/\\/evil.com',
      '/\\\\evil.com',
      '/safe\\evil.com',
    ]) {
      assert.equal(safeReturnPath(value, ORIGIN), null, JSON.stringify(value))
    }
  })

  test('rejects ASCII whitespace and line breaks', () => {
    for (const value of [
      '/\tevil.com',
      '/\nevil.com',
      '/\revil.com',
      '/ evil.com',
    ]) {
      assert.equal(safeReturnPath(value, ORIGIN), null, JSON.stringify(value))
    }
  })

  test('rejects control characters', () => {
    for (const value of [
      '/\u0000evil.com',
      '/\u001Fevil.com',
      '/\u007Fevil.com',
      '/\u0085evil.com',
    ]) {
      assert.equal(safeReturnPath(value, ORIGIN), null, JSON.stringify(value))
    }
  })

  test('rejects non-ASCII whitespace that URL parsing may normalize or ignore', () => {
    for (const value of [
      '/\u00A0evil.com',
      '/\u2028evil.com',
      '/\uFEFFevil.com',
    ]) {
      assert.equal(safeReturnPath(value, ORIGIN), null, JSON.stringify(value))
    }
  })

  test('rejects empty or missing values', () => {
    assert.equal(safeReturnPath('', ORIGIN), null)
    assert.equal(safeReturnPath(null, ORIGIN), null)
    assert.equal(safeReturnPath(undefined, ORIGIN), null)
  })

  test('keeps the account page wired to the shared validator and fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/account/page.tsx'), 'utf8')

    assert.match(source, /import \{ safeReturnPath \} from ['"]@\/lib\/safeReturnPath['"]/) 
    assert.match(source, /safeReturnPath\(rawReturn, window\.location\.origin\) \?\? ['"]\/modules['"]/) 
    assert.doesNotMatch(
      source,
      /rawReturn\.startsWith\(['"]\/['"]\)\s*&&\s*!rawReturn\.startsWith\(['"]\/\/['"]\)/,
    )
  })
})
