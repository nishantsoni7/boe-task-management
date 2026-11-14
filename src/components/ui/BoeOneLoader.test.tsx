/**
 * The BOE One loader — what it promised, pinned.
 *
 *   1. The drawing is the brand logo, unchanged (never redrawn).
 *   2. It shows only when a wait is real: transparent for a pause first, in CSS,
 *      so it needs no script and a quick page never flashes it.
 *   3. LoadingScreen (about 190 call sites) is this loader; a click that waits
 *      for its page reveals one more through <html data-boe-nav-pending>.
 *   4. Reduced motion gets the finished logo, still.
 *   5. The old spinner rules stay: the payroll saving overlay and the task-load
 *      error box still use them.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoeOneLoader, CHEER_LINES } from './BoeOneLoader'
import { LoadingScreen } from './atoms'
import { AppLink } from './AppLink'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
const CSS = read('src/app/globals.css')
/** The body of the first rule whose selector is exactly `selector`. */
const rule = (selector: string) => {
  const start = CSS.indexOf(`\n${selector} {`)
  assert.ok(start >= 0, `a rule for ${selector}`)
  return CSS.slice(start, CSS.indexOf('}', start))
}

const BRAND_PATH = /<path[^>]* d="([^"]+)"/.exec(read('public/brand/svg/boe-one-symbol-charcoal.svg'))?.[1] ?? ''

describe('the drawing', () => {
  test('the brand logo is found to compare against', () => {
    assert.ok(BRAND_PATH.startsWith('M '), 'the brand symbol path was not read')
  })

  test('every drawn copy of the mark is the brand logo path, unchanged', () => {
    const html = renderToStaticMarkup(createElement(BoeOneLoader))
    // the clip, the fill and the outline
    assert.equal(html.split(`d="${BRAND_PATH}"`).length - 1, 3)
  })

  test('it is a status for assistive technology, and the drawing itself is hidden from it', () => {
    const html = renderToStaticMarkup(createElement(BoeOneLoader, { message: 'Loading the board...' }))
    assert.match(html, /role="status"/)
    assert.match(html, /aria-live="polite"/)
    assert.match(html, /<svg[^>]*aria-hidden="true"/)
    assert.match(html, />Loading the board\.\.\.</)
  })

  test('the cheering one-liners are on by default, can be switched off, and are never announced', () => {
    const on = renderToStaticMarkup(createElement(BoeOneLoader))
    assert.match(on, /<div class="boe-loader-lines" aria-hidden="true">/)
    assert.equal(on.split('class="boe-loader-line"').length - 1, CHEER_LINES.length)
    assert.match(on, /style="--i:0"/)
    assert.match(on, new RegExp(`style="--i:${CHEER_LINES.length - 1}"`))
    assert.doesNotMatch(on, /Taking longer/, 'the owner asked for these instead of "taking longer than usual"')
    const off = renderToStaticMarkup(createElement(BoeOneLoader, { cheer: false }))
    assert.doesNotMatch(off, /boe-loader-line/)
  })

  test('the lines are short and kind: each fits two lines of the box, none is a technical warning', () => {
    assert.equal(new Set(CHEER_LINES).size, CHEER_LINES.length, 'no line twice')
    for (const line of CHEER_LINES) {
      assert.ok(line.length <= 60, `too long for two lines at 36ch: ${line}`)
      assert.doesNotMatch(line, /error|fail|timed? ?out|connection|reload|refresh/i, line)
    }
  })

  test('two copies on one page do not share the ids their clip and gradient are looked up by', () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, createElement(BoeOneLoader), createElement(BoeOneLoader)))
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1])
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4)
  })
})

describe('where it is used', () => {
  test('LoadingScreen is the loader, with its message and its option', () => {
    const html = renderToStaticMarkup(createElement(LoadingScreen))
    assert.match(html, /class="boe-loader"/)
    assert.match(html, />Loading\.\.\.</)
    assert.match(html, /boe-loader-line/)
    assert.doesNotMatch(html, /boe-loading-spinner/)
    const notAWait = renderToStaticMarkup(createElement(LoadingScreen, { message: 'Task not found', cheer: false }))
    assert.match(notAWait, /Task not found/)
    assert.doesNotMatch(notAWait, /boe-loader-line/)
  })

  test('"Task not found" is not a wait, so it gets no cheering lines', () => {
    assert.ok(read('src/app/tasks/[id]/page.tsx').includes('<LoadingScreen message="Task not found" cheer={false} />'))
  })

  test('the root layout carries the hidden loader that a waiting click reveals', () => {
    assert.ok(read('src/app/layout.tsx').includes('<BoeOneLoader className="boe-nav-loader"'))
  })

  test('AppLink adds nothing to the page: its probe draws no element', () => {
    const html = renderToStaticMarkup(createElement(AppLink, { href: '/orders' }, 'Orders'))
    assert.match(html, /^<a [^>]*href="\/orders"[^>]*>Orders<\/a>$/)
  })

  test('AppLink is a client component and reports a waiting click through useLinkStatus', () => {
    const src = read('src/components/ui/AppLink.tsx')
    assert.ok(src.startsWith("'use client'"))
    assert.ok(src.includes('useLinkStatus()'))
    assert.ok(src.includes('beginNavWait(document.documentElement)'))
  })
})

describe('the stylesheet', () => {
  test('it covers the whole screen, above the modals', () => {
    const r = rule('.boe-loader')
    assert.match(r, /position: fixed;/)
    assert.match(r, /inset: 0;/)
    const z = Number(/z-index: (\d+)/.exec(r)?.[1])
    assert.ok(z >= 10000, 'modals use up to 9999')
  })

  test('it is transparent first and fades in after a delay, so a quick page never flashes it', () => {
    const r = rule('.boe-loader')
    assert.match(r, /opacity: 0;/)
    assert.match(r, /animation: boe-loader-in 0\.4s ease-out var\(--boe-loader-delay, 0\.8s\) forwards;/)
  })

  test('the logo forms in a loop that starts when the layer starts to show', () => {
    for (const cls of ['.boe-loader-trace', '.boe-loader-fill', '.boe-loader-sheen']) {
      assert.match(rule(cls), /animation: boe-loader-\w+ 3\.6s var\(--boe-loader-delay, 0\.8s\) infinite;/, cls)
    }
    for (const name of ['boe-loader-in', 'boe-loader-trace', 'boe-loader-fill', 'boe-loader-sheen']) {
      assert.ok(CSS.includes(`@keyframes ${name} `), name)
    }
  })

  test('the lines go round on a cycle that matches the list: 4.5 s each, fade-out step 100 / length', () => {
    const n = CHEER_LINES.length
    const cycle = n * 4.5
    assert.match(rule('.boe-loader-line'), new RegExp(`animation: boe-loader-line ${cycle}s calc\\(var\\(--boe-loader-delay, 0\\.8s\\) \\+ 1s \\+ var\\(--i\\) \\* 4\\.5s\\) infinite;`))
    const at = CSS.indexOf('@keyframes boe-loader-line {')
    assert.ok(at >= 0)
    const frames = CSS.slice(at, CSS.indexOf('\n}\n', at))
    assert.ok(frames.includes(`${100 / n}%  { opacity: 0; }`), 'the line must be gone by the end of its slot')
    assert.ok(rule('.boe-loader-line').includes('opacity: 0;'), 'a line is invisible until its turn')
  })

  test('the loader for a waiting click is hidden until <html> is marked, waits 1.2 s, and lets clicks through', () => {
    const hidden = rule('.boe-loader.boe-nav-loader')
    assert.match(hidden, /display: none;/)
    assert.match(hidden, /--boe-loader-delay: 1\.2s;/)
    assert.match(hidden, /pointer-events: none;/)
    assert.ok(CSS.includes('html[data-boe-nav-pending] .boe-loader.boe-nav-loader { display: flex; }'))
  })

  test('with reduced motion the finished logo is shown still', () => {
    const at = CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  .boe-loader-trace')
    assert.ok(at >= 0)
    const block = CSS.slice(at, CSS.indexOf('\n}\n', at))
    assert.match(block, /\.boe-loader-fill \{ animation: none; fill-opacity: 1; \}/)
    assert.match(block, /\.boe-loader-sheen \{ display: none; \}/)
    assert.match(block, /\.boe-loader-line:not\(:first-child\) \{ display: none; \}/)
    assert.match(block, /\.boe-loader-line:first-child \{ animation: boe-loader-in /)
  })

  test('the old spinner rules stay for their other users', () => {
    assert.ok(CSS.includes('\n.boe-loading-spinner {'))
    assert.ok(CSS.includes('\n.boe-loading {'))
    assert.ok(read('src/app/payroll/results/[periodId]/[employeeId]/page.tsx').includes('className="boe-loading-spinner"'))
    assert.ok(read('src/app/tasks/[id]/page.tsx').includes('className="boe-loading"'))
  })
})
