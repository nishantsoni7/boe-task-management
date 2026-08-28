/**
 * THE INTERNAL TEAM ALLOWLIST — and the ways it must fail.
 *
 * The allowlist is what stands between "open WhatsApp with this text" and
 * "message a real customer by mistake". A permissive failure mode would make it
 * decorative, so most of this file is about failure: unset, empty, whitespace,
 * comments only, one bad entry among good ones. Every one of those must produce
 * a REFUSAL rather than a shorter list.
 *
 * Repository files and pure functions only. No database, no network, and no
 * real phone number anywhere in the file.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/allowlist.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOWLIST_ENV_VAR,
  findAllowedNumber,
  parseInternalTestAllowlist,
  readInternalTestAllowlist,
} from './allowlist'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/**
 * The same file with its comments removed.
 *
 * Several assertions below ask what the code DOES — whether it holds a default
 * number, how many times it reads process.env. allowlist.ts documents its own
 * configuration format with an example number and explains which single line
 * does the reading, so searching the raw text finds the explanation and reports
 * it as the thing being explained.
 */
const executable = (p: string) =>
  read(p)
    .split('\n')
    .filter(l => {
      const t = l.trimStart()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

// Fictional numbers in a documentation range. They are not dialled, formatted
// into a message, or written anywhere by this file.
const A = '+919999900001'
const B = '+919999900002'

const ok = (raw: string) => {
  const result = parseInternalTestAllowlist(raw)
  assert.equal(result.ok, true, `expected a usable list, got ${JSON.stringify(result)}`)
  return result as Extract<typeof result, { ok: true }>
}

const refused = (raw: string | undefined | null, reason: 'missing' | 'empty' | 'malformed') => {
  const result = parseInternalTestAllowlist(raw)
  assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(raw)}`)
  assert.equal((result as Extract<typeof result, { ok: false }>).reason, reason)
  return result as Extract<typeof result, { ok: false }>
}

describe('IT FAILS CLOSED, every way it can fail', () => {
  test('unset is a refusal, not an empty list', () => {
    // The distinction that matters: an empty list would let a caller "check"
    // against nothing and find nothing wrong.
    refused(undefined, 'missing')
    refused(null, 'missing')
  })

  test('empty and whitespace are refusals', () => {
    refused('', 'empty')
    refused('   ', 'empty')
    refused('\n\n', 'empty')
  })

  test('a value that is only commas, or only comments, is a refusal', () => {
    refused(',,,', 'empty')
    refused('# nobody has filled this in yet', 'empty')
    refused('# one\n# two', 'empty')
  })

  test('ONE BAD ENTRY REFUSES THE WHOLE LIST', () => {
    // The most important assertion in the file. Dropping the bad entry and
    // carrying on would mean a deployment that believed it had three approved
    // numbers running with two, silently, forever.
    refused(`${A},not-a-number,${B}`, 'malformed')
    refused(`${A},+91,${B}`, 'malformed')
    refused(`${A},+0123456789012,${B}`, 'malformed')
  })

  test('a national number without a country code is refused, not guessed', () => {
    // normalizeWhatsAppNumber offers a bare-10-digit convenience to a HUMAN
    // typing into a form. Extending it to configuration would be guessing which
    // country a colleague is in, and the guess would decide who gets messaged.
    refused('9999900001', 'malformed')
    refused('Ops|9999900001', 'malformed')
    refused('00919999900001', 'malformed')
  })

  test('a refusal NEVER contains a number, only a position', () => {
    // The detail goes to a server log, and a log line is exactly the place a
    // phone number must not appear.
    const result = refused(`${A},not-a-number`, 'malformed')
    assert.equal(result.detail.includes('not-a-number'), false)
    assert.equal(result.detail.includes('9999900001'), false)
    assert.ok(result.detail.includes('entry 2'))
    assert.ok(result.detail.includes(ALLOWLIST_ENV_VAR))
  })

  test('THERE IS NO DEFAULT AND NO BUILT-IN NUMBER', () => {
    // Read off the source: no fallback list, no sample number, nothing that
    // could stand in when the variable is absent.
    const source = executable('src/lib/customerReviews/allowlist.ts')
    const digits = [...source.matchAll(/\+\d{6,}/g)].map(m => m[0])
    assert.deepEqual(digits, [], `allowlist.ts contains hard-coded numbers: ${digits.join(', ')}`)
    assert.equal(/DEFAULT_NUMBERS|FALLBACK/.test(source), false)
  })

  test('the reader is the only thing that touches process.env', () => {
    const source = executable('src/lib/customerReviews/allowlist.ts')
    assert.equal((source.match(/process\.env/g) ?? []).length, 1)
    // ...and the variable is server-only, so Next never inlines it into a
    // client bundle.
    assert.equal(ALLOWLIST_ENV_VAR.startsWith('NEXT_PUBLIC_'), false)
  })

  test('reading an unset environment refuses, in the real reader too', () => {
    const saved = process.env[ALLOWLIST_ENV_VAR]
    try {
      delete process.env[ALLOWLIST_ENV_VAR]
      const result = readInternalTestAllowlist()
      assert.equal(result.ok, false)
      assert.equal((result as { reason: string }).reason, 'missing')
    } finally {
      if (saved === undefined) delete process.env[ALLOWLIST_ENV_VAR]
      else process.env[ALLOWLIST_ENV_VAR] = saved
    }
  })
})

describe('what it accepts, and how it normalises it', () => {
  test('a bare list of international numbers', () => {
    const { numbers } = ok(`${A},${B}`)
    assert.deepEqual(numbers.map(n => n.e164), [A, B])
    assert.deepEqual(numbers.map(n => n.digits), ['919999900001', '919999900002'])
  })

  test('labels, so a tester picks a person rather than a number', () => {
    const { numbers } = ok(`Ops test phone|${A}`)
    assert.equal(numbers[0].label, 'Ops test phone')
  })

  test('an unlabelled entry falls back to the masked number, never the full one', () => {
    const { numbers } = ok(A)
    assert.equal(numbers[0].label, '•••• 0001')
    assert.equal(numbers[0].label.includes('9999'), false)
  })

  test('newlines, commas, blank entries and comments all parse', () => {
    const { numbers } = ok(`# team\nOps|${A}\n\n, QA|${B} ,`)
    assert.equal(numbers.length, 2)
    assert.deepEqual(numbers.map(n => n.label), ['Ops', 'QA'])
  })

  test('spacing and punctuation inside a number are normalised away', () => {
    const { numbers } = ok('+91 99999 00001')
    assert.equal(numbers[0].e164, A)
  })

  test('a duplicate is collapsed rather than listed twice', () => {
    const { numbers } = ok(`Ops|${A},Also Ops|+91 99999 00001`)
    assert.equal(numbers.length, 1)
  })

  test('a label is stripped of control characters and bounded', () => {
    const evil = `${String.fromCharCode(7)}Ops${String.fromCharCode(0)}`
    const { numbers } = ok(`${evil}|${A}`)
    assert.equal(numbers[0].label, 'Ops')
    const long = ok(`${'x'.repeat(200)}|${A}`)
    assert.equal(long.numbers[0].label.length, 60)
  })
})

describe('findAllowedNumber is the check the routes make', () => {
  const { numbers } = ok(`Ops|${A},QA|${B}`)

  test('an approved number is found, however it is written', () => {
    for (const spelling of [A, '+91 99999 00001', '919999900001', '9999900001', '0091 99999 00001']) {
      assert.ok(findAllowedNumber(spelling, numbers), spelling)
    }
  })

  test('EVERY NUMBER NOT ON THE LIST IS REJECTED', () => {
    for (const stranger of ['+919999900003', '+14155550100', '+441632960001']) {
      assert.equal(findAllowedNumber(stranger, numbers), null, stranger)
    }
  })

  test('nonsense, empty and null are rejected without throwing', () => {
    for (const junk of ['', '   ', 'nope', '+', null, undefined]) {
      assert.equal(findAllowedNumber(junk, numbers), null, String(junk))
    }
  })

  test('an EMPTY allowlist matches nothing at all', () => {
    // The fail-closed shape at the point of use: given no approved numbers,
    // every candidate is refused rather than every candidate being permitted.
    assert.equal(findAllowedNumber(A, []), null)
  })

  test('it returns the APPROVED entry, not the caller’s spelling', () => {
    // What the route then uses to build the link. The number in the URL comes
    // from the server's own list, not from the request body.
    const found = findAllowedNumber('9999900001', numbers)!
    assert.equal(found.e164, A)
    assert.equal(found.digits, '919999900001')
    assert.equal(found.label, 'Ops')
  })
})

describe('the deployment is told how to configure it', () => {
  test('.env.example documents the variable, with placeholders only', () => {
    const example = read('.env.example')
    assert.ok(example.includes(ALLOWLIST_ENV_VAR), 'the variable is not documented')
    assert.ok(example.includes('FAILS CLOSED'))
    assert.ok(example.includes('DO NOT COMMIT REAL NUMBERS'))
  })

  test('and no real-looking number is committed anywhere in the module', () => {
    // The documentation range 99999 0000x is used in the example and in this
    // test. Anything else that looks like a mobile number would be somebody's.
    for (const file of [
      '.env.example',
      'src/lib/customerReviews/allowlist.ts',
      'src/app/api/customer-reviews/whatsapp/route.ts',
      'src/components/customerReviews/WhatsAppLaunch.tsx',
    ]) {
      const found = [...read(file).matchAll(/\+\d[\d\s]{9,}/g)].map(m => m[0].replace(/\s/g, ''))
      // .env.example and the format documentation both use placeholders in the
      // 99999 0000x documentation range, plus the +91 98765 43210 shape the
      // repository already uses as its example everywhere else.
      for (const number of found) {
        assert.ok(
          number.startsWith('+9199999') || number === '+919876543210',
          `${file} contains what looks like a real number: ${number}`,
        )
      }
    }
  })
})
