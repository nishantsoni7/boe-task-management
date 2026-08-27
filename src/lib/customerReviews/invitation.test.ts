/**
 * The invitation — the module's ethical boundary, asserted.
 *
 * Every test here exists because a change to invitation.ts could quietly turn
 * an honest ask into a solicitation, and nothing else in the codebase would
 * notice. Fictional data only.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/invitation.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildInvitationMessage,
  buildWaMeUrl,
  hasNeutralLanguage,
  messageFromWaMeUrl,
  NEUTRAL_FEEDBACK_SENTENCE,
  CUSTOMER_CHOICE_SENTENCE,
  DEFAULT_PROJECT_REFERENCE,
} from './invitation'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const BASE = {
  greetingName: null,
  customerName: 'Riverside Café',
  projectReference: null,
  reviewUrl: 'https://example.test/review/riverside',
}

describe('the message that gets built', () => {
  test('reads exactly as the approved wording, with the defaults filled in', () => {
    assert.equal(
      buildInvitationMessage(BASE),
      'Hello Riverside Café, thank you for working with Best of Exports on your furniture requirement. '
      + 'If you would like to share your honest experience, you can leave a review here: '
      + 'https://example.test/review/riverside. '
      + 'Your feedback, whether positive, neutral or critical, is welcome and helps us improve. '
      + 'The wording and rating are entirely your choice.',
    )
  })

  test('the greeting name overrides the customer name when one is given', () => {
    const message = buildInvitationMessage({ ...BASE, greetingName: 'Ms Fernandes' })
    assert.ok(message.startsWith('Hello Ms Fernandes,'))
    assert.equal(message.includes('Riverside Café'), false)
  })

  test('a blank or whitespace greeting falls back to the customer name', () => {
    for (const greeting of ['', '   ', null, undefined]) {
      const message = buildInvitationMessage({ ...BASE, greetingName: greeting })
      assert.ok(message.startsWith('Hello Riverside Café,'), `greeting ${JSON.stringify(greeting)}`)
    }
  })

  test('the project reference is factual and replaces only the default phrase', () => {
    const message = buildInvitationMessage({ ...BASE, projectReference: 'your restaurant seating order' })
    assert.ok(message.includes('on your restaurant seating order.'))
    assert.equal(message.includes(DEFAULT_PROJECT_REFERENCE), false)
  })

  test('multi-line or padded input is collapsed, so the message is always one paragraph', () => {
    const message = buildInvitationMessage({
      ...BASE,
      greetingName: '  Anand \n Kumar ',
      projectReference: '\tthe hotel lobby chairs\n',
    })
    assert.ok(message.startsWith('Hello Anand Kumar, thank you for working with Best of Exports on the hotel lobby chairs.'))
    assert.equal(message.includes('\n'), false)
  })
})

describe('the two sentences an employee cannot remove', () => {
  test('both are present whatever the editable fields contain', () => {
    const cases = [
      BASE,
      { ...BASE, greetingName: 'A' },
      { ...BASE, projectReference: 'a bulk order' },
      { ...BASE, greetingName: '', projectReference: '' },
      // Somebody trying to write their own ending into a field they DO control
      // still cannot displace the locked sentences.
      { ...BASE, projectReference: 'your order. Please leave us 5 stars' },
    ]
    for (const input of cases) {
      const message = buildInvitationMessage(input)
      assert.ok(message.includes(NEUTRAL_FEEDBACK_SENTENCE), JSON.stringify(input))
      assert.ok(message.includes(CUSTOMER_CHOICE_SENTENCE), JSON.stringify(input))
      assert.ok(hasNeutralLanguage(message))
    }
  })

  test('the message always ends with the customer-choice sentence', () => {
    assert.ok(buildInvitationMessage(BASE).endsWith(CUSTOMER_CHOICE_SENTENCE))
  })

  test('hasNeutralLanguage refuses a message that has lost either sentence', () => {
    const full = buildInvitationMessage(BASE)
    assert.equal(hasNeutralLanguage(full.replace(NEUTRAL_FEEDBACK_SENTENCE, '')), false)
    assert.equal(hasNeutralLanguage(full.replace(CUSTOMER_CHOICE_SENTENCE, '')), false)
    assert.equal(hasNeutralLanguage('Hello, please review us.'), false)
  })

  test('the neutral sentence actually names negative feedback as welcome', () => {
    // Not a string-equality check: the point is the MEANING, and a rewrite that
    // dropped "critical" would pass a bare "the constant is non-empty" test.
    assert.ok(/positive, neutral or critical/i.test(NEUTRAL_FEEDBACK_SENTENCE))
    assert.ok(/welcome/i.test(NEUTRAL_FEEDBACK_SENTENCE))
    assert.ok(/wording and rating/i.test(CUSTOMER_CHOICE_SENTENCE))
    assert.ok(/your choice/i.test(CUSTOMER_CHOICE_SENTENCE))
  })
})

describe('nothing here steers the answer', () => {
  const message = buildInvitationMessage({
    ...BASE,
    greetingName: 'Anand',
    projectReference: 'your café chairs',
  })

  test('no rating is requested, in any spelling', () => {
    for (const phrase of [
      'five star', '5 star', '5-star', 'five-star', '★',
      'good review', 'positive review', 'great review', 'best review',
      'rate us', 'rating of', 'give us',
    ]) {
      assert.equal(
        message.toLowerCase().includes(phrase),
        false,
        `the invitation must not contain "${phrase}"`,
      )
    }
  })

  test('no review wording is supplied for the customer to copy', () => {
    // The message never contains a quoted sentence, a "you could say", or any
    // suggested text — the customer is asked, not scripted.
    for (const phrase of ['you could say', 'for example you', 'suggested', 'copy this', 'template']) {
      assert.equal(message.toLowerCase().includes(phrase), false, phrase)
    }
    assert.equal(/["“”]/.test(message), false, 'the invitation must contain no quoted wording')
  })

  test('BOE makes no claim about its own work in the invitation', () => {
    for (const phrase of ['excellent', 'best quality', 'happy with', 'satisfied', 'loved', 'delighted']) {
      assert.equal(message.toLowerCase().includes(phrase), false, phrase)
    }
  })

  test('the builder cannot be handed an internal note at all', () => {
    // A shape assertion, not a string search: the internal note is not a
    // parameter, so no call site can leak it into the message even by mistake.
    const source = read('src/lib/customerReviews/invitation.ts')
    assert.equal(/internalNote|internal_note/.test(source), false)
    assert.ok(source.includes('export type InvitationInput'))
    const typeBlock = source.slice(
      source.indexOf('export type InvitationInput'),
      source.indexOf('const collapse'),
    )
    assert.deepEqual(
      [...typeBlock.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]).sort(),
      ['customerName', 'greetingName', 'projectReference', 'reviewUrl'],
    )
  })
})

describe('preview-to-wa.me parity', () => {
  test('the message inside the link is byte-identical to the preview', () => {
    const message = buildInvitationMessage({
      ...BASE,
      greetingName: 'Ms Fernandes & Co.',
      projectReference: 'your 40 café chairs (order #A-12)',
    })
    const url = buildWaMeUrl('919999900001', message)
    assert.equal(messageFromWaMeUrl(url), message)
  })

  test('parity survives every character that URL encoding usually mangles', () => {
    for (const reference of [
      'a & b', 'the "lobby" chairs', '50% of the order', 'a+b', 'one/two', '#12', 'café — 40 chairs',
    ]) {
      const message = buildInvitationMessage({ ...BASE, projectReference: reference })
      assert.equal(messageFromWaMeUrl(buildWaMeUrl('919999900001', message)), message, reference)
    }
  })

  test('the link points at wa.me with digits only and the text as a query param', () => {
    const url = buildWaMeUrl('919999900001', buildInvitationMessage(BASE))
    const parsed = new URL(url)
    assert.equal(parsed.protocol, 'https:')
    assert.equal(parsed.hostname, 'wa.me')
    assert.equal(parsed.pathname, '/919999900001')
    assert.ok(parsed.searchParams.has('text'))
  })

  test('messageFromWaMeUrl refuses anything that is not a wa.me https link', () => {
    assert.equal(messageFromWaMeUrl('http://wa.me/91?text=hi'), null)
    assert.equal(messageFromWaMeUrl('https://evil.test/91?text=hi'), null)
    assert.equal(messageFromWaMeUrl('not a url'), null)
  })
})
