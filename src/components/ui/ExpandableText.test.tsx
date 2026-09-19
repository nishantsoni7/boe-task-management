/**
 * ExpandableText — rendering contract
 *
 * The clamp must be CSS that applies before any JavaScript measures anything,
 * and the text must never be truncated in the markup: a long comment stays
 * whole in the DOM so expanding is instant and find-in-page still reaches it.
 *
 * The toggle itself is measured against real layout, which a static render has
 * none of — so a server render correctly shows no button. That is asserted
 * here rather than left implicit, because a toggle that appeared on text that
 * already fits is the one outcome worse than no toggle at all.
 *
 * Run:
 *   npx tsx --test src/components/ui/ExpandableText.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpandableText, ACTIVITY_TEXT_CLAMP_LINES } from './ExpandableText'

const render = (text: string, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<ExpandableText {...props}>{text}</ExpandableText>)

const LONG = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the update`).join('\n')

describe('ExpandableText', () => {
  test('the ceiling is eight lines', () => {
    assert.equal(ACTIVITY_TEXT_CLAMP_LINES, 8)
  })

  test('a long comment is clamped by CSS, not cut from the markup', () => {
    const html = render(LONG)
    assert.match(html, /-webkit-line-clamp:8/)
    assert.match(html, /overflow:hidden/)
    assert.ok(html.includes('Line 30 of the update'), 'every line is still in the DOM')
  })

  test('the clamp needs -webkit-box to take effect', () => {
    const html = render(LONG)
    assert.match(html, /display:-webkit-box/)
    assert.match(html, /-webkit-box-orient:vertical/)
  })

  test('newlines and long unbroken strings still behave as MultilineText', () => {
    const html = render(`first\n\nsecond ${'A'.repeat(300)}`)
    assert.match(html, /white-space:pre-wrap/)
    assert.match(html, /overflow-wrap:anywhere/)
  })

  test('a caller may set its own ceiling', () => {
    assert.match(render(LONG, { clampLines: 3 }), /-webkit-line-clamp:3/)
  })

  test('the caller typography survives the clamp', () => {
    const html = render(LONG, { style: { fontSize: '12.5px', color: '#596273' } })
    assert.match(html, /font-size:12\.5px/)
    assert.match(html, /color:#596273/)
  })

  test('the toggle is a real button carrying its own state', () => {
    // A static render draws no toggle (nothing has been measured), so the
    // contract is asserted at the source: a native button — focusable and
    // Enter/Space-activatable for free — that announces expanded or collapsed
    // rather than only its label.
    const src = readFileSync(join(process.cwd(), 'src/components/ui/ExpandableText.tsx'), 'utf8')
    assert.match(src, /type="button"/)
    assert.match(src, /aria-expanded=\{expanded\}/)
  })

  test('no toggle is drawn before anything has been measured', () => {
    // Server render / first paint: there is no layout, so overflow is unknown
    // and no "Read more…" is offered on text that may already fit.
    assert.equal(render(LONG).includes('Read more'), false)
    assert.equal(render('short').includes('<button'), false)
  })
})
