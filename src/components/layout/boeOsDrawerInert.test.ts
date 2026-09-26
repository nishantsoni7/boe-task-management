/**
 * BOE OS phone drawer — a closed drawer is not keyboard- or screen-reader-
 * reachable.
 *
 * Below 768px the BoeOsLayout sidebar becomes a drawer that is translated
 * off-screen when closed. Off-screen is not gone: its Home, Announcements,
 * Switch User and account controls stayed Tab stops and stayed in the
 * accessibility tree. The closed drawer is now `inert`, on phone widths only;
 * the permanent desktop sidebar is untouched.
 *
 * Run:
 *   npx tsx --test src/components/layout/boeOsDrawerInert.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDrawerInert, PHONE_DRAWER_QUERY } from './BoeOsLayout'

const ROOT = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const LAYOUT = read('src/components/layout/BoeOsLayout.tsx')
const CSS = read('src/app/globals.css')

describe('the closed phone drawer is inert', () => {
  test('inert only while it is a drawer AND closed', () => {
    assert.equal(isDrawerInert(true, false), true, 'phone, closed: unreachable')
    assert.equal(isDrawerInert(true, true), false, 'phone, open: its links are reachable')
    assert.equal(isDrawerInert(false, false), false, 'desktop: the permanent sidebar is never inert')
    assert.equal(isDrawerInert(false, true), false)
  })

  test('the JavaScript breakpoint is the one CSS turns the sidebar into a drawer at', () => {
    assert.equal(PHONE_DRAWER_QUERY, '(max-width: 767px)')
    const at = CSS.indexOf('@media (max-width: 767px) {\n  /* ── Sidebar drawer')
    assert.notEqual(at, -1, 'globals.css still makes the drawer at 767px')
    assert.match(CSS.slice(at, at + 400), /\.boe-sidebar \{[^}]*transform: translateX\(-100%\)/)
  })

  test('the aside carries inert and the toggle describes and controls it', () => {
    assert.match(LAYOUT, /<aside[\s\S]{0,200}id="boe-os-drawer"[\s\S]{0,200}inert=\{isDrawerInert\(isPhone, sidebarOpen\)\}/)
    assert.match(LAYOUT, /aria-expanded=\{sidebarOpen\}/)
    assert.match(LAYOUT, /aria-controls="boe-os-drawer"/)
  })

  test('the server snapshot is the desktop sidebar, so server markup is unchanged', () => {
    assert.match(LAYOUT, /window\.matchMedia\(PHONE_DRAWER_QUERY\)\.matches,\n\s*\(\) => false,/)
  })

  test('no automatic reload rides in with the fix', () => {
    assert.equal(/location\.reload|router\.refresh/.test(LAYOUT), false)
  })
})
