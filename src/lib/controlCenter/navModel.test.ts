import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAIN_PATH, NAV_HUBS, NAV_SECTIONS, activeHub, hubHref, isSectionActive,
  resolveControlCenterTab, searchSections,
} from './navModel'

describe('navigation model', () => {
  test('ids and hrefs are unique, so nothing is listed twice', () => {
    const ids = NAV_SECTIONS.map(s => s.id)
    const hrefs = NAV_SECTIONS.map(s => s.href)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(new Set(hrefs).size, hrefs.length)
  })

  test('every in-app route has a page behind it', () => {
    for (const s of NAV_SECTIONS) {
      const path = s.href.split('?')[0]
      if (path === MAIN_PATH) continue
      assert.ok(existsSync(join(process.cwd(), 'src/app', path, 'page.tsx')), `${path} has no page`)
    }
  })

  test('the sidebar is short', () => {
    assert.equal(NAV_HUBS.length, 7)
  })

  test('a tab section is active only on the main page with that tab', () => {
    const numbering = NAV_SECTIONS.find(s => s.id === 'order-numbering')!
    assert.equal(isSectionActive(numbering, { pathname: MAIN_PATH, tab: 'order-numbering' }), true)
    assert.equal(isSectionActive(numbering, { pathname: MAIN_PATH, tab: 'departments' }), false)
    assert.equal(isSectionActive(numbering, { pathname: `${MAIN_PATH}/people`, tab: 'order-numbering' }), false)
  })

  test('Home is active with no tab, with ?tab=overview, and with a tab it does not know', () => {
    const home = NAV_SECTIONS.find(s => s.id === 'home')!
    assert.equal(isSectionActive(home, { pathname: MAIN_PATH, tab: null }), true)
    assert.equal(isSectionActive(home, { pathname: MAIN_PATH, tab: resolveControlCenterTab('bogus') }), true)
    assert.equal(isSectionActive(home, { pathname: `${MAIN_PATH}/people`, tab: null }), false)
  })

  test('the hub on show follows the screen, including the retired and orphaned ones', () => {
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/permissions/modules`, tab: null })?.id, 'access')
    assert.equal(activeHub({ pathname: MAIN_PATH, tab: 'modules' })?.id, 'access')
    assert.equal(activeHub({ pathname: MAIN_PATH, tab: 'departments' })?.id, 'people')
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/data-management`, tab: null })?.id, 'records')
    // Action Queue sits outside the map: no hub claims it.
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/action-queue`, tab: null }), null)
  })

  test('every hub opens inside the Control Center, so the sidebar never disappears', () => {
    for (const hub of NAV_HUBS) assert.ok(hubHref(hub).startsWith(MAIN_PATH), `${hub.label} opens outside the shell`)
  })

  test('a hub opens on its first screen', () => {
    for (const hub of NAV_HUBS) assert.equal(hubHref(hub), hub.sections[0].href)
  })

  describe('search', () => {
    const top = (q: string) => searchSections(q)[0]?.id
    test('finds a screen by its name', () => {
      assert.equal(top('departments'), 'departments')
      assert.equal(top('numbering'), 'order-numbering')
    })
    test('finds a screen by what the admin is trying to do', () => {
      assert.equal(top('reset password'), 'employees')
      assert.equal(top('next order number'), 'order-numbering')
      assert.equal(top('delete test order'), 'test-data-cleanup')
      assert.equal(top('who can open'), 'by-module')
      assert.equal(top('publish'), 'announcements')
    })
    test('every word must match, so more words narrow the result', () => {
      assert.equal(searchSections('employee xyzzy').length, 0)
      assert.ok(searchSections('order').length >= searchSections('order number').length)
    })
    test('an empty query matches nothing here (the dialog lists everything itself)', () => {
      assert.equal(searchSections('   ').length, 0)
    })
  })
})
