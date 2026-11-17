/**
 * Daily splash overlay — what the server renders, and what the overlay says.
 *
 * Run:
 *   npx tsx --test src/components/dailyQuoteLoader.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import DailyQuoteLoader from './DailyQuoteLoader'

const SOURCE = readFileSync(join(process.cwd(), 'src/components/DailyQuoteLoader.tsx'), 'utf8')

describe('DailyQuoteLoader', () => {
  test('the prerendered page keeps its real content and shows no splash', () => {
    const html = renderToStaticMarkup(<DailyQuoteLoader><main>The launcher</main></DailyQuoteLoader>)
    assert.match(html, /<main>The launcher<\/main>/)
    assert.ok(!html.includes('Daily splash'), 'the splash is a client-only overlay')
  })

  test('a long line can be dismissed, and the headline never blocks the page', () => {
    assert.match(SOURCE, /onClick=\{onSkip\}/)
    assert.match(SOURCE, /Escape/)
    // The fetch is on a timer after mount, never awaited before the splash decides.
    assert.match(SOURCE, /setTimeout\(\(\) => \{ void refreshHeadlines\(storage, fetch\) \}, 4000\)/)
    assert.ok(!/await refreshHeadlines/.test(SOURCE))
  })

  test('it still shows once a day and records that before the timers finish', () => {
    assert.match(SOURCE, /boe_daily_quote_seen_/)
    const persist = SOURCE.indexOf("localStorage.setItem(key, '1')")
    const timers = SOURCE.indexOf('setTimeout(() => setVisible(true)')
    assert.ok(persist > 0 && timers > persist, 'the once-a-day write must come before the timers')
  })

  test('the 50 fixed quotes and the day-of-year pick are gone', () => {
    assert.ok(!/const QUOTES\b/.test(SOURCE))
    assert.ok(!/dayOfYear/.test(SOURCE))
  })
})
