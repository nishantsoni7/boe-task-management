/**
 * THE NUMBER A TESTER TYPES: what is accepted, what is refused, and what is
 * never kept.
 *
 * There is no allowlist any more. An authorized tester enters any valid
 * international number, so this file carries the whole of what "valid" means —
 * and the refusals matter more than the acceptances, because a number that
 * slips through malformed is a link to somebody nobody meant to message.
 *
 * Pure functions. No database, no network, and no real number in the file:
 * everything below is either a reserved fiction range or a deliberately invalid
 * string.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/contact.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_NUMBER_DIGITS,
  MIN_NUMBER_DIGITS,
  isValidWhatsAppNumber,
  maskFromLastFour,
  maskWhatsAppNumber,
  normalizeWhatsAppNumber,
} from './contact'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const E164 = '+919999900001'

const accepted = (raw: string, expected = E164) => {
  const result = normalizeWhatsAppNumber(raw)
  assert.equal(result.ok, true, `expected ${JSON.stringify(raw)} to normalise, got ${JSON.stringify(result)}`)
  const okResult = result as Extract<typeof result, { ok: true }>
  assert.equal(okResult.e164, expected, raw)
  assert.equal(okResult.digits, expected.slice(1), raw)
  return okResult
}

const refused = (raw: string | null | undefined) => {
  const result = normalizeWhatsAppNumber(raw)
  assert.equal(result.ok, false, `expected ${JSON.stringify(raw)} to be refused`)
  return result as Extract<typeof result, { ok: false }>
}

describe('valid international numbers normalise to one canonical form', () => {
  test('the shapes people actually type all reach the same E.164', () => {
    for (const spelling of [
      '+919999900001',
      '+91 99999 00001',
      '+91-99999-00001',
      '+91 (99999) 00001',
      '+91 (999) 990-0001',
      ' +91 99999 00001 ',
      '0091 99999 00001',
      '00919999900001',
      '0091-99999-00001',
    ]) {
      accepted(spelling)
    }
  })

  test('SPACES, PLUS, HYPHENS AND PARENTHESES are handled, and only those', () => {
    // The four separators the requirement names, each on its own, so a failure
    // says which one broke.
    accepted('+91 9999900001')
    accepted('+91-9999900001')
    accepted('+91(9999900001)')
    accepted('+919999900001')
    // Dots and the various Unicode dashes people paste out of documents.
    accepted('+91.99999.00001')
    accepted('+91‑99999‑00001')
  })

  test('numbers from several countries, not just BOE’s own', () => {
    // The point of the correction: a tester is no longer restricted to one
    // country's numbers. All three below are reserved fiction ranges.
    accepted('+1 (415) 555-0100', '+14155550100')
    accepted('+44 1632 960001', '+441632960001')
    accepted('+61 491 570 006', '+61491570006')
  })

  test('the shortest and longest E.164 numbers are both accepted', () => {
    assert.equal(MIN_NUMBER_DIGITS, 8)
    assert.equal(MAX_NUMBER_DIGITS, 15)
    accepted(`+${'1'.repeat(MIN_NUMBER_DIGITS)}`, `+${'1'.repeat(MIN_NUMBER_DIGITS)}`)
    accepted(`+${'1'.repeat(MAX_NUMBER_DIGITS)}`, `+${'1'.repeat(MAX_NUMBER_DIGITS)}`)
  })
})

describe('what is refused', () => {
  test('EMPTY, whitespace, null and undefined', () => {
    for (const nothing of ['', '   ', '\t', null, undefined]) {
      refused(nothing)
    }
  })

  test('TOO SHORT — one digit under the floor', () => {
    const result = refused(`+${'1'.repeat(MIN_NUMBER_DIGITS - 1)}`)
    assert.ok(result.error.includes('too short'))
  })

  test('TOO LONG — one digit over the ceiling', () => {
    const result = refused(`+${'1'.repeat(MAX_NUMBER_DIGITS + 1)}`)
    assert.ok(result.error.includes('too long'))
  })

  test('MALFORMED — letters, symbols, and a number that is not one', () => {
    for (const junk of [
      'nope',
      '+91 98765 4321O',        // a typed letter O where a zero was meant
      '+91,99999,00001',
      '+91/99999/00001',
      'tel:+919999900001',
      '+',
      '++919999900001',
      '+91 99999 00001 ext 4',
    ]) {
      refused(junk)
    }
  })

  test('A LETTER IS NOT STRIPPED INTO SILENCE', () => {
    // The reason the digit check is a check and not a strip: stripping would
    // turn a mistyped letter into a valid-looking number one digit short of the
    // one that was meant, and the link would open a chat with a stranger.
    const stripped = '+91 98765 4321O'.replace(/[^0-9]/g, '')
    assert.equal(stripped.length, 11, 'the premise of this test has changed')
    refused('+91 98765 4321O')
  })

  test('A BARE NATIONAL NUMBER IS REFUSED, NOT GUESSED', () => {
    // The rule that tightened when the allowlist went away. While only BOE's
    // own numbers were reachable, assuming +91 for a bare ten digits was a safe
    // convenience. Now that any number can be typed, that assumption would be
    // silently choosing which country gets messaged.
    for (const bare of ['9999900001', '99999 00001', '(99999) 00001', '919999900001']) {
      const result = refused(bare)
      assert.ok(result.error.includes('country code'), `${bare}: ${result.error}`)
    }
  })

  test('a leading zero after the country code is refused', () => {
    // E.164 forbids it, and accepting it would produce a number that looks
    // valid and reaches nobody.
    refused('+09999900001')
    refused('00 0 9999900001')
  })

  test('NO ERROR MESSAGE CONTAINS ANY PART OF THE INPUT', () => {
    // The errors are shown on a screen and returned by the route, and a
    // validation message that quotes the number would put it somewhere nobody
    // audited. Every refusal is checked, not a sample.
    for (const junk of [
      '', '   ', 'nope', '+91 98765 4321O', '9999900001',
      '+1234567', `+${'1'.repeat(16)}`, '+09999900001', 'tel:+919999900001',
    ]) {
      const { error } = refused(junk)
      assert.equal(/\d{4,}/.test(error.replace(/\+91 98765 43210|0091 98765 43210/g, '')), false,
        `the error for ${JSON.stringify(junk)} carries digits: ${error}`)
      for (const fragment of ['nope', '4321O', 'tel:']) {
        assert.equal(error.includes(fragment), false, `the error echoes ${fragment}: ${error}`)
      }
    }
  })

  test('it returns a RESULT rather than throwing', () => {
    // A caller must handle the invalid case, not merely remember to catch it —
    // and an exception carrying a phone number in its message is exactly what
    // this shape avoids.
    for (const junk of ['', 'nope', null, undefined]) {
      assert.doesNotThrow(() => normalizeWhatsAppNumber(junk as string))
    }
  })
})

describe('isValidWhatsAppNumber is the canonical predicate', () => {
  test('it accepts exactly the canonical form', () => {
    assert.equal(isValidWhatsAppNumber(E164), true)
    for (const bad of ['919999900001', '+91 99999 00001', '', null, undefined, '+0123']) {
      assert.equal(isValidWhatsAppNumber(bad as string), false, String(bad))
    }
  })

  test('and it agrees with the normaliser on everything the normaliser accepts', () => {
    for (const spelling of ['+91 99999 00001', '0091 99999 00001', '+1 (415) 555-0100']) {
      const result = normalizeWhatsAppNumber(spelling)
      assert.equal(result.ok, true, spelling)
      assert.equal(isValidWhatsAppNumber((result as { e164: string }).e164), true, spelling)
    }
  })
})

describe('masking is what a screen shows, and it is all a screen has', () => {
  test('only the last four digits survive', () => {
    assert.equal(maskWhatsAppNumber(E164), '•••• •••• 0001')
    assert.equal(maskFromLastFour('0001'), '•••• •••• 0001')
  })

  test('THE COUNTRY CODE IS NOT SHOWN', () => {
    // A country code plus a length is already a strong hint about who somebody
    // is, and this string exists to be safe on a shared screen — and inside the
    // screenshots this module asks testers to upload.
    const masked = maskWhatsAppNumber(E164)
    assert.equal(masked.includes('91'), false)
    assert.equal(masked.includes('9999'), false)
  })

  test('an absent value reads as an em dash, not as an empty mask', () => {
    for (const nothing of [null, undefined, '']) {
      assert.equal(maskWhatsAppNumber(nothing), '—')
      assert.equal(maskFromLastFour(nothing), '—')
    }
  })

  test('maskFromLastFour refuses anything that is not four digits', () => {
    // It is fed a stored column, and a column that somehow held something else
    // must not be rendered as though it were a number.
    for (const bad of ['00', '00012', 'abcd', '12 4']) {
      assert.equal(maskFromLastFour(bad), '—', bad)
    }
  })
})

describe('the file keeps its own privacy promise', () => {
  test('THERE IS NO FULL-NUMBER FORMATTER AND NO wa.me HELPER LEFT', () => {
    // Both existed to work with a number the module had stored. It stores none,
    // so a function shaped to display or route one is a shape somebody would
    // eventually find a value for.
    const source = read('src/lib/customerReviews/contact.ts')
    assert.equal(/export function formatWhatsAppNumber/.test(source), false)
    assert.equal(/export function waMePhone/.test(source), false)
  })

  test('no function takes a context string that could carry a number elsewhere', () => {
    const source = read('src/lib/customerReviews/contact.ts')
    const executable = source
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal(/context|analytics|log/i.test(executable), false,
      'a function here accepts something a number could be formatted into')
  })

  test('nothing here logs, fetches or navigates', () => {
    const source = read('src/lib/customerReviews/contact.ts')
    for (const forbidden of ['console.', 'fetch(', 'window.', 'localStorage']) {
      assert.equal(source.includes(forbidden), false, `contact.ts uses ${forbidden}`)
    }
  })

  test('and it holds no number of its own beyond the documented example', () => {
    const source = read('src/lib/customerReviews/contact.ts')
    for (const m of source.matchAll(/\+\d[\d\s]{7,}/g)) {
      const compact = m[0].replace(/\s/g, '')
      assert.ok(
        compact.startsWith('+919876543210') || compact.startsWith('+919'),
        `contact.ts contains an unexpected number: ${compact}`,
      )
    }
  })
})

describe('THERE IS NO ALLOWLIST', () => {
  test('the module no longer ships one', () => {
    // Deleted rather than emptied: an allowlist file with nothing in it is one
    // somebody re-populates.
    for (const gone of [
      'src/lib/customerReviews/allowlist.ts',
      'src/lib/customerReviews/allowlist.test.ts',
    ]) {
      assert.throws(() => read(gone), `${gone} still exists`)
    }
  })

  test('and no environment variable is required to reach a number', () => {
    assert.equal(read('.env.example').includes('BOE_INTERNAL_TEST_WHATSAPP_NUMBERS'), false)
    // Checked against the EXECUTABLE source. Each of these files explains in
    // its header that there is no allowlist and what replaced it — which is
    // exactly the documentation this correction should leave behind, and a raw
    // text search would report it as the thing it forbids.
    for (const file of [
      'src/lib/customerReviews/contact.ts',
      'src/app/api/customer-reviews/whatsapp/route.ts',
      'src/components/customerReviews/WhatsAppLaunch.tsx',
    ]) {
      const executable = read(file)
        .split('\n')
        .filter(l => {
          const t = l.trimStart()
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
        })
        .join('\n')
      assert.equal(/allowlist/i.test(executable), false, `${file} still has allowlist code`)
      assert.equal(read(file).includes('BOE_INTERNAL_TEST_WHATSAPP_NUMBERS'), false,
        `${file} still names the removed variable`)
    }
  })
})
