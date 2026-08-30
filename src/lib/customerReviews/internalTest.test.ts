/**
 * THE MANDATORY LABEL, and the message that carries it.
 *
 * This is the file that proves the module's central non-negotiable: every test
 * message begins with
 *
 *     INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH
 *
 * and an employee cannot remove it. "Cannot" is asserted three ways here —
 * behaviourally (the builder always puts it first), structurally (there is no
 * parameter that suppresses it), and against the database (the SQL constant is
 * the same string) — because a promise about a label is only as good as the
 * thing that makes it impossible to break.
 *
 * NOTHING IN THIS FILE OPENS WHATSAPP. The wa.me assertions decode the URL and
 * compare it to the message; no test navigates to it, and no test issues a
 * network request of any kind.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/internalTest.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INTERNAL_TEST_EXPLANATION,
  INTERNAL_TEST_WARNING,
  buildInternalTestMessage,
  buildWaMeUrl,
  hasInternalTestWarning,
  messageFromWaMeUrl,
  phoneFromWaMeUrl,
} from './internalTest'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const CARD = {
  title: 'Restaurant layout test, short',
  body: 'Short restaurant-test filler. It describes nothing real.',
  categoryLabel: 'Restaurant test',
  reference: 'TEST-001',
}

describe('the label itself', () => {
  test('it says exactly what it must say', () => {
    // Written out rather than referenced, so a change to the constant is a
    // visible change to this line too.
    assert.equal(INTERNAL_TEST_WARNING, 'INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH')
  })

  test('it names all three things: what it is, what it is not, and what not to do', () => {
    assert.ok(INTERNAL_TEST_WARNING.includes('INTERNAL TEST ONLY'))
    assert.ok(INTERNAL_TEST_WARNING.includes('NOT A CUSTOMER REVIEW'))
    assert.ok(INTERNAL_TEST_WARNING.includes('DO NOT PUBLISH'))
  })

  test('THE SQL CONSTANT IS THE SAME STRING', () => {
    // The database holds its own copy so the fixture's CHECK can refuse a card
    // body carrying one. Two copies of a string is how they drift, so they are
    // pinned to each other here.
    //
    // Compared on the NORMALIZED form: the application constant uses en dashes
    // for display and the SQL one uses ASCII hyphens, because a migration file
    // is read in terminals and diffs where an en dash is a liability. The WORDS
    // must be identical; the dash is a rendering choice.
    const sql = read('supabase/migrations/20261017000000_customer_review_outreach.sql')
    const inSql = /select '([^']+)'::text;/.exec(
      sql.slice(sql.indexOf('create or replace function public.customer_review_internal_test_warning()')),
    )?.[1]
    assert.ok(inSql, 'the SQL constant is missing')
    const normalize = (s: string) => s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()
    assert.equal(normalize(inSql!), normalize(INTERNAL_TEST_WARNING))
  })
})

describe('the message always carries it', () => {
  const message = buildInternalTestMessage(CARD)

  test('IT IS THE FIRST THING IN THE MESSAGE', () => {
    // Not merely present. A notification preview shows the first line, so a
    // label anywhere else could be pushed below the fold on a colleague's lock
    // screen.
    assert.ok(message.startsWith(INTERNAL_TEST_WARNING))
  })

  test('and the last, so a truncated forward still carries it', () => {
    assert.ok(message.trimEnd().endsWith(INTERNAL_TEST_WARNING))
  })

  test('hasInternalTestWarning agrees, and refuses a message without it', () => {
    assert.equal(hasInternalTestWarning(message), true)
    assert.equal(hasInternalTestWarning('Hello, please leave us a review.'), false)
    // Present but not first: still refused.
    assert.equal(hasInternalTestWarning(`Hello. ${INTERNAL_TEST_WARNING}`), false)
  })

  test('THE LABEL IS NOT A PARAMETER, so no caller can decline it', () => {
    // The structural half of "impossible to remove". buildInternalTestMessage
    // takes four fields and none of them is the label, a prefix, a flag or an
    // override — so there is no argument a caller could pass to suppress it.
    const source = read('src/lib/customerReviews/internalTest.ts')
    const signature = source.slice(
      source.indexOf('export type InternalTestMessageInput'),
      source.indexOf('const collapse'),
    )
    assert.deepEqual(
      [...signature.matchAll(/^  (\w+):/gm)].map(m => m[1]),
      ['title', 'body', 'categoryLabel', 'reference'],
    )
    for (const escape of ['warning', 'prefix', 'suppress', 'skipLabel', 'omit']) {
      assert.equal(signature.toLowerCase().includes(escape.toLowerCase()), false,
        `the input type has a ${escape} field`)
    }
  })

  test('...and the builder has no branch that leaves it out', () => {
    const source = read('src/lib/customerReviews/internalTest.ts')
    const builder = source.slice(
      source.indexOf('export function buildInternalTestMessage'),
      source.indexOf('export function hasInternalTestWarning'),
    )
    // Exactly two occurrences — the opening and the closing — and no `if`.
    assert.equal((builder.match(/INTERNAL_TEST_WARNING/g) ?? []).length, 2)
    assert.equal(/\bif\s*\(/.test(builder), false, 'the builder branches')
  })

  test('it explains what the recipient should do with it', () => {
    assert.ok(message.includes(INTERNAL_TEST_EXPLANATION))
    assert.ok(INTERNAL_TEST_EXPLANATION.includes('must not be'))
    assert.ok(INTERNAL_TEST_EXPLANATION.includes('not from a customer'))
  })

  test('IT MAKES NO CLAIM ABOUT WHO THE RECIPIENT IS', () => {
    // The defect a walkthrough surfaced: the message told a recipient it had
    // been "sent to a BOE internal team number", which was true under the
    // allowlist and false the moment any number could be typed. A message that
    // tells its reader something untrue about themselves is the exact thing
    // this module refuses to produce.
    //
    // What it may say is where it came from. What it may not say is who
    // received it.
    for (const claim of [
      'internal team number',
      'team number',
      'approved number',
      'your BOE',
      'colleague',
    ]) {
      assert.equal(
        INTERNAL_TEST_EXPLANATION.toLowerCase().includes(claim.toLowerCase()), false,
        `the explanation claims something about the recipient: "${claim}"`,
      )
    }
    // ...and it still says where it DID come from, which BOE can vouch for.
    assert.ok(INTERNAL_TEST_EXPLANATION.includes('BOE'))
    assert.ok(INTERNAL_TEST_EXPLANATION.includes('internal test system'))
  })

  test('it carries the card’s reference, so a screenshot can be matched back', () => {
    assert.ok(message.includes('TEST-001'))
    assert.ok(message.includes('Restaurant test'))
  })

  test('THE MESSAGE ASKS FOR NOTHING', () => {
    // No rating, no review, no verdict, no link, no call to action. It is a
    // system test that happens to arrive by WhatsApp.
    const lower = message.toLowerCase()
    for (const phrase of [
      'review', 'rating', 'rate us', 'stars', 'feedback', 'please',
      'http', 'www.', 'google', 'link',
    ]) {
      // 'review' appears in the label — as a NEGATION — so the label is removed
      // before the body is searched.
      const withoutLabel = lower.split(INTERNAL_TEST_WARNING.toLowerCase()).join(' ')
      const withoutExplanation = withoutLabel.split(INTERNAL_TEST_EXPLANATION.toLowerCase()).join(' ')
      assert.equal(withoutExplanation.includes(phrase), false, `the message says "${phrase}"`)
    }
  })
})

describe('the wa.me address, INSPECTED and never opened', () => {
  const message = buildInternalTestMessage(CARD)
  const url = buildWaMeUrl('919999900001', message)

  test('it is an https wa.me address and nothing else', () => {
    const parsed = new URL(url)
    assert.equal(parsed.protocol, 'https:')
    assert.equal(parsed.hostname, 'wa.me')
    assert.equal(parsed.pathname, '/919999900001')
    // One parameter. Anything else would be something nobody put there on
    // purpose.
    assert.deepEqual([...parsed.searchParams.keys()], ['text'])
  })

  test('THE TEXT DECODES BACK TO EXACTLY THE PREVIEWED MESSAGE', () => {
    // The parity assertion. What a tester reads before clicking is what
    // WhatsApp is handed — proved by decoding the URL rather than by trusting
    // that two code paths built the same string.
    assert.equal(messageFromWaMeUrl(url), message)
  })

  test('and it is correctly encoded — newlines, spaces and punctuation survive', () => {
    const tricky = buildInternalTestMessage({
      ...CARD,
      body: 'Filler with "quotes", an ampersand &, a plus +, a hash # and a percent 100%.',
    })
    const round = messageFromWaMeUrl(buildWaMeUrl('919999900001', tricky))
    assert.equal(round, tricky)
    // The raw URL must not contain a bare & or # inside the parameter, which
    // would truncate it.
    const raw = buildWaMeUrl('919999900001', tricky)
    const afterText = raw.slice(raw.indexOf('?text=') + 6)
    assert.equal(afterText.includes('&'), false)
    assert.equal(afterText.includes('#'), false)
  })

  test('the label survives the round trip, first and last', () => {
    const decoded = messageFromWaMeUrl(url)!
    assert.ok(hasInternalTestWarning(decoded))
  })

  test('phoneFromWaMeUrl reads the recipient back, for inspection', () => {
    assert.equal(phoneFromWaMeUrl(url), '919999900001')
  })

  test('a URL that is not wa.me is refused rather than parsed', () => {
    for (const bad of [
      'https://example.test/?text=hi',
      'http://wa.me/91?text=hi',
      'javascript:alert(1)',
      'not a url',
    ]) {
      assert.equal(messageFromWaMeUrl(bad), null, bad)
      assert.equal(phoneFromWaMeUrl(bad), null, bad)
    }
  })

  test('NOTHING IN THIS MODULE SENDS, FETCHES OR OPENS ANYTHING', () => {
    // buildWaMeUrl returns a string. There is no WhatsApp API client in this
    // repository, no token, and no outbound call in this file — so a test that
    // exercises it cannot contact anybody.
    const source = read('src/lib/customerReviews/internalTest.ts')
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'window.open', 'location.href',
                             'axios', 'graph.facebook.com', 'api.whatsapp.com']) {
      assert.equal(source.includes(forbidden), false, `internalTest.ts uses ${forbidden}`)
    }
  })

  test('and this test file has nothing to navigate WITH', () => {
    // Asserted by what it IMPORTS rather than by searching its own text for
    // "fetch(" — a search that matches the search term itself, which is how the
    // first version of this assertion failed on its own list of forbidden
    // words.
    //
    // Four node built-ins and the module under test. No HTTP client, no
    // browser, no supabase client: there is nothing in scope here that could
    // reach WhatsApp even if somebody wrote the call.
    const self = read('src/lib/customerReviews/internalTest.test.ts')
    const imports = [...self.matchAll(/^import [\s\S]*?from '([^']+)'/gm)].map(m => m[1]).sort()
    assert.deepEqual(imports, [
      './internalTest',
      'node:assert/strict',
      'node:fs',
      'node:path',
      'node:test',
    ])
  })
})

describe('the label reaches the screen as well as the message', () => {
  test('the component renders the constant and accepts no text', () => {
    const pieces = read('src/components/customerReviews/ReviewPieces.tsx')
    const component = pieces.slice(
      pieces.indexOf('export function InternalTestWarning'),
      pieces.indexOf('export function ReviewBadge'),
    )
    assert.ok(component.includes('{INTERNAL_TEST_WARNING}'))
    // The whole design: a caller decides WHERE it appears, never WHAT it says.
    assert.equal(/children/.test(component), false, 'the warning component accepts children')
    assert.equal(/\btext\s*[?:]/.test(component), false, 'the warning component accepts text')
    // Its only prop.
    assert.ok(component.includes('{ compact = false }: { compact?: boolean }'))
  })

  test('the server refuses to return an unlabelled message', () => {
    const route = read('src/app/api/customer-reviews/whatsapp/route.ts')
    assert.ok(route.includes('if (!hasInternalTestWarning(message))'))
    assert.ok(route.includes('refusing to build an unlabelled test message'))
  })

  test('and the browser refuses to open one', () => {
    const launch = read('src/components/customerReviews/WhatsAppLaunch.tsx')
    assert.ok(launch.includes('!hasInternalTestWarning(built.message'))
    assert.ok(launch.includes('missing its internal-test label and was not opened'))
  })
})
