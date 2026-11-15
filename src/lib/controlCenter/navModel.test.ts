import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMMON_JOBS, MAIN_PATH, NAV_HUBS, NAV_SECTIONS, activeHub, activeSection, hubHref, isSectionActive,
  resolveControlCenterTab, searchSections, sectionById,
} from './navModel'

const SETTINGS = NAV_SECTIONS.filter(s => s.hub.id !== 'home')

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

  test('the sidebar is short: Home and six areas, holding nineteen settings', () => {
    assert.equal(NAV_HUBS.length, 7)
    assert.deepEqual(NAV_HUBS.map(h => h.id), ['home', 'people', 'access', 'orders', 'sales', 'staff', 'data'])
    assert.equal(SETTINGS.length, 19)
  })

  test('only Data & Safety is a danger area, and the setting that cannot be undone says so', () => {
    assert.deepEqual(NAV_HUBS.filter(h => h.danger).map(h => h.id), ['data'])
    assert.equal(sectionById('data-management')?.irreversible, true)
    assert.equal(SETTINGS.filter(s => s.irreversible).length, 1)
  })

  test('every setting says what it affects, and every related setting exists and is a different one', () => {
    for (const s of SETTINGS) {
      assert.ok(s.affects.trim().length > 0, `${s.id} does not say what it affects`)
      assert.ok(s.short.trim().length > 0, `${s.id} has no directory line`)
      for (const id of s.related) {
        assert.ok(sectionById(id), `${s.id} is related to ${id}, which does not exist`)
        assert.notEqual(id, s.id, `${s.id} is related to itself`)
      }
    }
  })

  test('settings are filed by the job: WhatsApp and Sales team are Sales, not Records or Access', () => {
    assert.equal(sectionById('whatsapp-connection')?.hub.id, 'sales')
    assert.equal(sectionById('sales-team')?.hub.id, 'sales')
    assert.equal(sectionById('announcements')?.hub.id, 'staff')
    assert.equal(sectionById('for-you')?.hub.id, 'staff')
    assert.equal(sectionById('task-records')?.hub.id, 'data')
  })

  test('the two screens that were both "People" now have different names', () => {
    const labels = SETTINGS.map(s => s.label)
    assert.equal(labels.filter(l => l === 'People').length, 0)
    assert.equal(sectionById('by-person')?.label, 'By person')
    assert.equal(sectionById('by-module')?.label, 'By module')
  })

  test('Day Close & Scoreboard is findable and opens its own page, in Staff experience', () => {
    assert.equal(searchSections('pause scoreboard')[0]?.id, 'day-close-switch')
    assert.equal(searchSections('strikes')[0]?.id, 'day-close-switch')
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/day-close`, tab: null })?.id, 'staff')
  })

  test('Review leaderboard is findable and opens its own page, in Staff experience', () => {
    assert.equal(searchSections('hide leaderboard')[0]?.id, 'review-rankings')
    assert.equal(searchSections('ranking')[0]?.id, 'review-rankings')
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/review-rankings`, tab: null })?.id, 'staff')
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

  test('the area on show follows the screen, including the retired and orphaned ones', () => {
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/permissions/modules`, tab: null })?.id, 'access')
    assert.equal(activeHub({ pathname: MAIN_PATH, tab: 'modules' })?.id, 'access')
    assert.equal(activeHub({ pathname: MAIN_PATH, tab: 'people' })?.id, 'people')
    assert.equal(activeHub({ pathname: MAIN_PATH, tab: 'departments' })?.id, 'people')
    assert.equal(activeHub({ pathname: MAIN_PATH, tab: 'sales-team' })?.id, 'sales')
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/data-management`, tab: null })?.id, 'data')
    // The Action Queue is gone: its old address is outside the map, so no area claims it.
    assert.equal(activeHub({ pathname: `${MAIN_PATH}/action-queue`, tab: null }), null)
  })

  test('the retired ?tab= values land on the screen that replaced them', () => {
    assert.equal(activeSection({ pathname: MAIN_PATH, tab: 'modules' })?.id, 'by-module')
    assert.equal(activeSection({ pathname: MAIN_PATH, tab: 'people' })?.id, 'employees')
  })

  test('every area opens inside the Control Center, so the sidebar never disappears', () => {
    for (const hub of NAV_HUBS) assert.ok(hubHref(hub).startsWith(MAIN_PATH), `${hub.label} opens outside the shell`)
  })

  test('an area opens on its first screen', () => {
    for (const hub of NAV_HUBS) assert.equal(hubHref(hub), hub.sections[0].href)
  })

  test('every common job lands on a real setting', () => {
    assert.equal(COMMON_JOBS.length, 5)
    for (const job of COMMON_JOBS) {
      const s = sectionById(job.sectionId)
      assert.ok(s, `${job.label} points at ${job.sectionId}, which does not exist`)
      assert.ok(job.href.startsWith(s.href.split('?')[0]), `${job.label} does not open ${s.label}`)
    }
  })

  describe('search', () => {
    const top = (q: string) => searchSections(q)[0]?.id
    test('finds a screen by its name', () => {
      assert.equal(top('departments'), 'departments')
      assert.equal(top('numbering'), 'order-numbering')
      assert.equal(top('whatsapp'), 'whatsapp-connection')
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
    test('an empty query matches nothing here (the dialog and Home list things themselves)', () => {
      assert.equal(searchSections('   ').length, 0)
    })
  })
})
