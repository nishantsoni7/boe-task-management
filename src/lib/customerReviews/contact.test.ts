/**
 * Phone numbers: normalising, masking, and keeping them out of everything that
 * is not a wa.me path.
 *
 * WHOSE NUMBERS THESE ARE. BOE internal team numbers, and only those — this
 * module holds no customer contact data and has no column that could. The
 * functions here turn a string into a canonical form and back into a display
 * string; whether a number may be MESSAGED is answered by findAllowedNumber
 * against the server-held allowlist, which has its own tests.
 *
 * Pure functions. No database, no network, and no real number in the file.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/contact.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_COUNTRY_CODE,
  formatWhatsAppNumber,
  isValidWhatsAppNumber,
  maskWhatsAppNumber,
  normalizeWhatsAppNumber,
  waMePhone,
} from './contact'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const E164 = '+919999900001'

const okValue = (raw: string) => {
  const result = normalizeWhatsAppNumber(raw)
  assert.equal(result.ok, true, `expected ${raw} to normalise, got ${JSON.stringify(result)}`)
  return result as Extract<typeof result, { ok: true }>
}

const rejected = (raw: string | null | undefined) => {
  const result = normalizeWhatsAppNumber(raw)
  assert.equal(result.ok, false, `expected ${String(raw)} to be refused`)
  return result as Extract<typeof result, { ok: false }>
}

describe('normalising what somebody typed', () => {
  test('the shapes people actually paste all reach one canonical form', () => {
    for (const spelling of [
      '+919999900001',
      '+91 99999 00001',
      '+91-99999-00001',
      '(+91) 99999 00001',
      '00919999900001',
      '0091 99999 00001',
    ]) {
      assert.equal(okValue(spelling).e164, E164, spelling)
    }
  })

  test('a bare ten-digit number gets the default country code, and ONLY a bare ten', () => {
    assert.equal(DEFAULT_COUNTRY_CODE, '91')
    assert.equal(okValue('9999900001').e164, E164)
    // Eleven digits is not a national number with a missing code; it is either a
    // typo or somebody else's country, and guessing would decide who is
    // messaged.
    assert.equal(okValue('99999000012').e164, '+99999000012')
  })

  test('an international number is never silently turned into an Indian one', () => {
    assert.equal(okValue('+14155550100').e164, '+14155550100')
    assert.equal(okValue('+441632960001').e164, '+441632960001')
  })

  test('it returns a RESULT rather than throwing', () => {
    // A caller must handle the invalid case, not merely remember to catch it —
    // and an exception carrying a phone number in its message is exactly what
    // this shape avoids.
    for (const junk of ['', '   ', 'nope', '+', 'abc def', '12345']) {
      const result = rejected(junk)
      assert.ok(result.error.length > 0)
      assert.equal(/\d{6,}/.test(result.error), false, `the error carries digits: ${result.error}`)
    }
  })

  test('null and undefined are refused, not coerced', () => {
    rejected(null)
    rejected(undefined)
  })

  test('a leading zero after the country code is refused', () => {
    // E.164 forbids it, and accepting it would produce a number that looks
    // valid and reaches nobody.
    rejected('+09999900001')
  })

  test('too short and too long are both refused', () => {
    rejected('+911')
    rejected('+9199999000012345678')
  })

  test('isValidWhatsAppNumber agrees with the normaliser about the canonical form', () => {
    assert.equal(isValidWhatsAppNumber(E164), true)
    for (const bad of ['919999900001', '+91 99999 00001', '', null, undefined, '+0123']) {
      assert.equal(isValidWhatsAppNumber(bad as string), false, String(bad))
    }
  })
})

describe('masking is a display control, and it is the default', () => {
  test('only the last four digits survive', () => {
    assert.equal(maskWhatsAppNumber(E164), '•••• •••• 0001')
  })

  test('THE COUNTRY CODE IS NOT SHOWN', () => {
    // A country code plus a length is already a strong hint about who somebody
    // is, and this string exists to be safe on a shared screen — and inside the
    // screenshots this module asks testers to upload.
    const masked = maskWhatsAppNumber(E164)
    assert.equal(masked.includes('91'), false)
    assert.equal(masked.includes('9999'), false)
  })

  test('an absent number reads as an em dash, not as an empty mask', () => {
    assert.equal(maskWhatsAppNumber(null), '—')
    assert.equal(maskWhatsAppNumber(undefined), '—')
    assert.equal(maskWhatsAppNumber(''), '—')
  })

  test('something too short to mask is still masked', () => {
    assert.equal(maskWhatsAppNumber('+12'), '••••')
  })

  test('the readable form is for a deliberate reveal, and refuses a malformed value', () => {
    assert.equal(formatWhatsAppNumber(E164), '+91 99999 00001')
    assert.equal(formatWhatsAppNumber('919999900001'), '—')
    assert.equal(formatWhatsAppNumber(null), '—')
  })
})

describe('the wa.me path', () => {
  test('digits only, no plus — which is what wa.me expects', () => {
    assert.equal(waMePhone(E164), '919999900001')
  })

  test('A MALFORMED VALUE PRODUCES NO LINK AT ALL, not a guess', () => {
    // A best guess here would be a link to the wrong person.
    for (const bad of ['919999900001', '+91 99999 00001', 'nope', '', null, undefined]) {
      assert.equal(waMePhone(bad as string), null, String(bad))
    }
  })
})

describe('the file keeps its own privacy promise', () => {
  test('no function takes a context string that could carry a number elsewhere', () => {
    const source = read('src/lib/customerReviews/contact.ts')
    const executable = source.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
    assert.equal(/context|label|message|log/i.test(executable.replace(/\/\*[\s\S]*?\*\//g, '')), false,
      'a function here accepts something a number could be formatted into')
  })

  test('nothing here logs, fetches or navigates', () => {
    const source = read('src/lib/customerReviews/contact.ts')
    for (const forbidden of ['console.', 'fetch(', 'window.', 'localStorage']) {
      assert.equal(source.includes(forbidden), false, `contact.ts uses ${forbidden}`)
    }
  })

  test('and it holds no number of its own', () => {
    const source = read('src/lib/customerReviews/contact.ts')
    const executable = source.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
    assert.deepEqual([...executable.matchAll(/\+\d{6,}/g)].map(m => m[0]), [])
  })
})
