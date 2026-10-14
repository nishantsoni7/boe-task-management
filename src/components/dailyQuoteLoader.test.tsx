/**
 * The first-open daily quote must not hold anybody.
 *
 * Measured 2026-09-26: the fixed 2.5 s overlay added 1.6 s (phone profile) and
 * 2.1 s (desktop) to each person's first open of the day. It now lifts on the
 * first interaction and on its own after QUOTE_TOTAL_MS.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import DailyQuoteLoader, { QUOTE_DISMISS_EVENTS, QUOTE_FADE_OUT_AT_MS, QUOTE_TOTAL_MS } from './DailyQuoteLoader'

const src = readFileSync(join(__dirname, 'DailyQuoteLoader.tsx'), 'utf8').replace(/\r/g, '')

describe('the quote is short and dismissible', () => {
  test('it lasts well under the old 2.5 s', () => {
    assert.ok(QUOTE_TOTAL_MS <= 1600)
    assert.ok(QUOTE_FADE_OUT_AT_MS < QUOTE_TOTAL_MS)
  })
  test('any tap, click, key, scroll or touch hands the page back', () => {
    for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart']) assert.ok((QUOTE_DISMISS_EVENTS as readonly string[]).includes(e), e)
    assert.ok(/window\.addEventListener\(type, dismiss, \{ capture: true, once: true, passive: true \}\)/.test(src))
    assert.ok(/window\.removeEventListener\(type, dismiss, \{ capture: true \}\)/.test(src), 'listeners are removed on unmount')
  })
  test('no hard-coded 2.5 s / 2.1 s timings remain', () => {
    assert.equal(/setTimeout\([^)]*, 2[15]00\)/.test(src), false)
    assert.equal(src.includes("'boe-progress 2.1s"), false)
  })
  test('the reader is told how to continue', () => {
    assert.ok(src.includes('Tap anywhere to continue'))
  })
})

describe('unchanged behaviour', () => {
  test('the page still renders underneath (server render includes the children)', () => {
    const html = renderToStaticMarkup(createElement(DailyQuoteLoader, null, createElement('main', null, 'Modules content')))
    assert.ok(html.includes('Modules content'))
  })
  test('once per day, recorded when shown', () => {
    assert.ok(src.includes('boe_daily_quote_seen_'))
    assert.ok(/localStorage\.setItem\(key, '1'\)[\s\S]{0,400}setPhase\('quote'\)/.test(src), 'the key is written before the quote shows')
  })
})
