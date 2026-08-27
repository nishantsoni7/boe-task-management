/**
 * WhatsApp number handling: normalisation, validation, masking, and the one
 * place the full number is allowed to go.
 *
 * Fictional numbers only. The +91 99999 000xx range used throughout is not a
 * real allocation.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/contact.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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

describe('normalising what an employee typed', () => {
  test('the shapes people actually paste all reach one canonical form', () => {
    for (const input of [
      '+919999900001',
      '+91 99999 00001',
      '+91-99999-00001',
      '+91 (99999) 00001',
      '0091 99999 00001',
      '00919999900001',
      '9999900001',
      '99999 00001',
      '  +919999900001  ',
    ]) {
      const result = normalizeWhatsAppNumber(input)
      assert.ok(result.ok, `${input} should normalise`)
      assert.equal(result.ok && result.e164, '+919999900001', input)
      assert.equal(result.ok && result.digits, '919999900001', input)
    }
  })

  test('the default country code applies ONLY to a bare ten-digit number', () => {
    assert.equal(DEFAULT_COUNTRY_CODE, '91')

    // Bare national number → country code added.
    const bare = normalizeWhatsAppNumber('9999900001')
    assert.equal(bare.ok && bare.e164, '+919999900001')

    // An international number is never silently turned into an Indian one.
    const uk = normalizeWhatsAppNumber('+447700900001')
    assert.equal(uk.ok && uk.e164, '+447700900001')

    // Eleven digits with no '+' is taken at face value, not prefixed.
    const eleven = normalizeWhatsAppNumber('19999900001')
    assert.equal(eleven.ok && eleven.e164, '+19999900001')
  })

  test('a different default country can be passed without touching the shared one', () => {
    const result = normalizeWhatsAppNumber('7700900001', '44')
    assert.equal(result.ok && result.e164, '+447700900001')
    // The shared default is unchanged for the next caller.
    const again = normalizeWhatsAppNumber('9999900001')
    assert.equal(again.ok && again.e164, '+919999900001')
  })

  test('nonsense is refused with a sentence, not an exception', () => {
    for (const input of ['', '   ', 'call me', '12', '+0123456789', '9'.repeat(20)]) {
      const result = normalizeWhatsAppNumber(input)
      assert.equal(result.ok, false, JSON.stringify(input))
      assert.ok(result.ok === false && result.error.length > 0)
    }
  })

  test('the failure NEVER echoes the number back', () => {
    // An error message is the classic place private data escapes to — a toast,
    // a log line, a bug report. The refusal must be generic.
    const result = normalizeWhatsAppNumber('+0123456789')
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.error.includes('0123456789'), false)
  })

  test('isValidWhatsAppNumber only accepts stored E.164', () => {
    assert.equal(isValidWhatsAppNumber('+919999900001'), true)
    assert.equal(isValidWhatsAppNumber('919999900001'), false)   // no '+'
    assert.equal(isValidWhatsAppNumber('+0919999900001'), false) // leading zero
    assert.equal(isValidWhatsAppNumber('+91 99999 00001'), false) // not canonical
    assert.equal(isValidWhatsAppNumber(null), false)
    assert.equal(isValidWhatsAppNumber(undefined), false)
  })
})

describe('masking', () => {
  test('only the last four digits survive', () => {
    assert.equal(maskWhatsAppNumber('+919999900001'), '•••• •••• 0001')
    assert.equal(maskWhatsAppNumber('+447700912345'), '•••• •••• 2345')
  })

  test('the country code is NOT revealed by the mask', () => {
    const masked = maskWhatsAppNumber('+919999900001')
    assert.equal(masked.includes('91'), false)
    assert.equal(masked.includes('+'), false)
  })

  test('two different numbers sharing a suffix mask identically — that is the point', () => {
    assert.equal(
      maskWhatsAppNumber('+919999900001'),
      maskWhatsAppNumber('+447700900001'),
    )
  })

  test('nothing to mask reads as an em dash, never as an empty mask', () => {
    assert.equal(maskWhatsAppNumber(null), '—')
    assert.equal(maskWhatsAppNumber(''), '—')
  })
})

describe('the one place the full number is allowed to go', () => {
  test('waMePhone returns digits only, for the wa.me path', () => {
    assert.equal(waMePhone('+919999900001'), '919999900001')
  })

  test('a malformed stored number produces NO link rather than a guess', () => {
    for (const value of [null, '', '919999900001', 'not a number', '+0919999900001']) {
      assert.equal(waMePhone(value), null, JSON.stringify(value))
    }
  })

  test('formatWhatsAppNumber is for the reveal control and groups readably', () => {
    assert.equal(formatWhatsAppNumber('+919999900001'), '+91 99999 00001')
    assert.equal(formatWhatsAppNumber(null), '—')
    assert.equal(formatWhatsAppNumber('919999900001'), '—')
  })
})

describe('the number stays out of everywhere else', () => {
  const moduleFiles = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) out.push(...moduleFiles(path))
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
    }
    return out
  }

  const sources = [
    ...moduleFiles('src/lib/customerReviews'),
    ...moduleFiles('src/components/customerReviews'),
    ...moduleFiles('src/app/customer-reviews'),
  ]

  test('no module file logs, alerts or reports the number', () => {
    // console.* with a request row in it is the realistic leak: a row carries
    // whatsapp_number, so logging one publishes it to every browser console and
    // every error reporter downstream.
    for (const file of sources) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const match of text.matchAll(/console\.(log|warn|error|info|debug)\(([^\n]*)/g)) {
        assert.equal(
          /whatsapp|number|request\b(?!s)|row|data/i.test(match[2]),
          false,
          `${file} logs something that may carry the customer's number: ${match[0]}`,
        )
      }
    }
  })

  test('the list screen renders the number only through the mask', () => {
    const list = readFileSync(join(ROOT, 'src/app/customer-reviews/CustomerReviewListScreen.tsx'), 'utf8')
    assert.ok(list.includes('<MaskedNumber value={r.whatsapp_number} />'))
    // No `revealable` on a list: a list is what gets screenshotted.
    assert.equal(/MaskedNumber[^/]*revealable/.test(list), false)
    assert.equal(list.includes('formatWhatsAppNumber'), false)
  })

  test('only the detail screen offers a reveal, and only for one record', () => {
    const detail = readFileSync(
      join(ROOT, 'src/app/customer-reviews/[id]/RequestDetailScreen.tsx'), 'utf8',
    )
    assert.ok(detail.includes('<MaskedNumber value={request.whatsapp_number} revealable />'))
  })
})
