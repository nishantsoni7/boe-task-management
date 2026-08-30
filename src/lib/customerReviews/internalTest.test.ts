/**
 * THE DRAFT STATUS, AND WHAT THE MESSAGE MAY CARRY.
 *
 * This file used to be about the opposite property. It asserted that
 * "INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH" appeared on
 * every card, at the top and bottom of every message, and in SQL — and that no
 * caller could suppress it.
 *
 * The cards are no longer internal filler, so that sentence would now be a
 * false statement printed in red on every screen. What replaced it is a small
 * neutral status, "AI-generated draft", and the interesting assertions inverted
 * with it:
 *
 *   BEFORE: the label must be PRESENT, everywhere, including in the message.
 *   NOW:    the status is present ON SCREEN, and the message carries NOTHING
 *           but the draft — no status, no reference, no retired warning, no
 *           link, address or number.
 *
 * The retired sentence still has one job. It is kept as a constant nothing
 * renders, so that generated drafts, seeded cards and outgoing messages can all
 * be checked against the exact string rather than an approximation of it — and
 * the CHECK constraint in migration 20261017000000 still refuses a body that
 * contains it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DRAFT_STATUS,
  RETIRED_TEST_WARNING,
  buildReviewMessage,
  buildWaMeUrl,
  isSendableReviewMessage,
} from './internalTest'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const DRAFT = {
  title: 'Booth seating that finally fits the room',
  body: 'We had an awkward L-shaped dining room and every supplier wanted to sell us standard booths. This team measured and built the run to match. Two years on the frames are still solid.',
  categoryLabel: 'Restaurant',
  reference: 'RW-000001',
}

// ══ 1. THE STATUS ═══════════════════════════════════════════════════════════

describe('the draft status', () => {
  test('it is the neutral wording, and says nothing about a test', () => {
    assert.equal(DRAFT_STATUS, 'AI-generated draft')
    assert.equal(/test/i.test(DRAFT_STATUS), false)
    assert.equal(/do not publish|internal/i.test(DRAFT_STATUS), false)
  })

  test('it does not claim the draft is a real customer’s words', () => {
    // The status exists to say the opposite: a model wrote this and nobody has
    // verified it as anybody's statement.
    assert.equal(/verified|genuine|real customer|actual/i.test(DRAFT_STATUS), false)
  })

  test('the component renders the constant and accepts no text', () => {
    const pieces = read('src/components/customerReviews/ReviewPieces.tsx')
    assert.ok(pieces.includes('export function InternalTestWarning({ compact = false }: { compact?: boolean }) {'))
    assert.ok(pieces.includes('<span>{DRAFT_STATUS}</span>'))
    // No `text` prop, no children: a caller decides WHERE it appears, never
    // WHAT it says.
    assert.equal(/InternalTestWarning\(\{[^}]*text/.test(pieces), false)
    assert.equal(/InternalTestWarning\(\{[^}]*children/.test(pieces), false)
  })
})

// ══ 2. THE RETIRED WARNING ══════════════════════════════════════════════════

describe('the retired internal-test warning', () => {
  test('nothing renders it', () => {
    for (const file of [
      'src/components/customerReviews/ReviewPieces.tsx',
      'src/components/customerReviews/WhatsAppLaunch.tsx',
      'src/components/customerReviews/ScreenshotManager.tsx',
      'src/app/customer-reviews/TestCardListScreen.tsx',
      'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
    ]) {
      const executable = read(file).split('\n')
        .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
        .join('\n')
      assert.equal(executable.includes(RETIRED_TEST_WARNING), false,
        `${file} still renders the retired warning`)
    }
  })

  test('but it is still kept as a constant, because the guards need it exactly', () => {
    assert.equal(RETIRED_TEST_WARNING, 'INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH')
  })

  test('and the database still refuses a body that carries it', () => {
    // The CHECK that once stopped a card duplicating the mandatory label now
    // does a second job for free: no generated draft may contain the retired
    // sentence either.
    const schema = read('supabase/migrations/20261017000000_customer_review_outreach.sql')
    assert.ok(schema.includes(
      'position(public.customer_review_internal_test_warning() in upper(test_body)) = 0'))
  })
})

// ══ 3. THE MESSAGE ══════════════════════════════════════════════════════════

describe('what WhatsApp is handed', () => {
  const message = buildReviewMessage(DRAFT)

  test('IT IS THE DRAFT, AND NOTHING ELSE', () => {
    assert.equal(message, DRAFT.body)
  })

  test('the status is NOT in it — it is UI metadata', () => {
    assert.equal(message.includes(DRAFT_STATUS), false)
  })

  test('neither is the retired warning', () => {
    assert.equal(message.includes(RETIRED_TEST_WARNING), false)
  })

  test('neither is the reference, the title or the category', () => {
    // Everything the module knows ABOUT a draft stays on our screen. A person
    // receiving a suggested review receives a suggested review.
    assert.equal(message.includes(DRAFT.reference), false)
    assert.equal(message.includes(DRAFT.categoryLabel), false)
    assert.equal(message.includes(DRAFT.title), false)
  })

  test('whitespace is collapsed, so a stored newline cannot fake a heading', () => {
    const noisy = buildReviewMessage({ ...DRAFT, body: 'One.\n\n\nTwo.   Three.' })
    assert.equal(noisy, 'One. Two. Three.')
  })
})

// ══ 4. THE SEND GUARD ═══════════════════════════════════════════════════════

describe('isSendableReviewMessage', () => {
  test('an ordinary draft passes', () => {
    assert.equal(isSendableReviewMessage(DRAFT.body), true)
  })

  test('an empty message does not', () => {
    assert.equal(isSendableReviewMessage(''), false)
    assert.equal(isSendableReviewMessage('   '), false)
  })

  test('a message carrying the retired warning does not', () => {
    assert.equal(isSendableReviewMessage(`${RETIRED_TEST_WARNING}\n${DRAFT.body}`), false)
  })

  test('a message carrying our own status does not', () => {
    assert.equal(isSendableReviewMessage(`${DRAFT_STATUS}: ${DRAFT.body}`), false)
  })

  test('and neither does one carrying a link, an address or a number', () => {
    for (const leak of [
      'Great chairs, see https://example.test for more',
      'Great chairs, visit www.example.test',
      'Great chairs — write to sales@example.test',
      'Great chairs, call +44 20 7946 0000',
    ]) {
      assert.equal(isSendableReviewMessage(leak), false, leak)
    }
  })
})

// ══ 5. THE URL ══════════════════════════════════════════════════════════════

describe('the wa.me link', () => {
  test('it decodes back to exactly the message that was built', () => {
    const message = buildReviewMessage(DRAFT)
    const url = new URL(buildWaMeUrl('12025550100', message))
    assert.equal(url.protocol, 'https:')
    assert.equal(url.host, 'wa.me')
    assert.equal(url.pathname, '/12025550100')
    assert.equal(decodeURIComponent(url.searchParams.get('text') ?? ''), message)
  })

  test('the number reaches the PATH, never the text', () => {
    const url = new URL(buildWaMeUrl('12025550100', buildReviewMessage(DRAFT)))
    assert.equal((url.searchParams.get('text') ?? '').includes('12025550100'), false)
  })
})

// ══ 6. NO USER-FACING TEST WORDING SURVIVES ═════════════════════════════════

describe('the module no longer calls itself a test', () => {
  const SCREENS = [
    'src/app/customer-reviews/TestCardListScreen.tsx',
    'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
    'src/components/customerReviews/WhatsAppLaunch.tsx',
    'src/components/customerReviews/ScreenshotManager.tsx',
    'src/components/customerReviews/ReviewPieces.tsx',
    'src/components/customerReviews/GenerateDrafts.tsx',
    'src/components/layout/CustomerReviewsLayout.tsx',
    'src/lib/customerReviews/status.ts',
    'src/lib/customerReviews/types.ts',
    'src/lib/permissions/modules.ts',
    'src/app/modules/page.tsx',
    'src/app/api/customer-reviews/whatsapp/route.ts',
    'src/app/api/customer-reviews/photos/route.ts',
    'src/app/api/customer-reviews/generate/route.ts',
  ]

  /** Executable lines only: a comment explaining what was removed is not it. */
  const executable = (source: string) =>
    source.split('\n')
      .filter(l => {
        const t = l.trimStart()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')

  test('no screen says "Review Workflow Test", "Book this test" or "My tests"', () => {
    const offenders: string[] = []
    for (const file of SCREENS) {
      const body = executable(read(file))
      for (const phrase of ['Review Workflow Test', 'Book this test', 'My tests']) {
        if (body.includes(phrase)) offenders.push(`${file}: ${phrase}`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('and none describes a card as an internal test', () => {
    const offenders: string[] = []
    for (const file of SCREENS) {
      const body = executable(read(file))
      if (/internal test|internal-test|test card|test message|booked test|test workflow/i.test(body)) {
        offenders.push(file)
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('the module displays "Review Workflow"', () => {
    assert.ok(read('src/lib/permissions/modules.ts').includes("displayName: 'Review Workflow'"))
    assert.ok(read('src/app/modules/page.tsx').includes("title: 'Review Workflow'"))
    assert.ok(read('src/app/customer-reviews/TestCardListScreen.tsx').includes('title="Review Workflow"'))
  })

  test('and the booking control says "Book"', () => {
    const list = read('src/app/customer-reviews/TestCardListScreen.tsx')
    assert.ok(list.includes("{booking ? 'Booking…' : 'Book'}"))
  })
})
