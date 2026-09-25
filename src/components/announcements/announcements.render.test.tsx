// The Modules banner and the header bell, rendered.
// Run: npx tsx --test src/components/announcements/announcements.render.test.tsx
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnnouncementBanner } from './AnnouncementBanner'
import { AnnouncementBell } from './AnnouncementBell'
import type { MyAnnouncement } from '@/lib/announcements'

const mk = (id: string, title: string, read = false): MyAnnouncement => ({
  id, title, summary: `About ${title}`, body: 'Full text', starts_on: '2026-10-01', ends_on: '2026-10-15',
  attachment_path: null, attachment_name: null, attachment_size: null,
  created_at: '2026-10-01T00:00:00Z', read_at: read ? '2026-10-02T00:00:00Z' : null,
})

describe('AnnouncementBanner', () => {
  test('one unread: its real title and summary, and the whole banner opens it', () => {
    const html = renderToStaticMarkup(<AnnouncementBanner announcements={[mk('a1', 'Exhibition staff guidelines')]} />)
    assert.ok(html.includes('Exhibition staff guidelines'))
    assert.ok(html.includes('About Exhibition staff guidelines'))
    assert.match(html, /^<a [^>]*href="\/announcements\/a1"/)
    assert.equal((html.match(/<a /g) ?? []).length, 1, 'one control, not nested links')
  })

  test('acknowledged announcements produce no banner at all', () => {
    assert.equal(renderToStaticMarkup(<AnnouncementBanner announcements={[mk('a1', 'X', true)]} />), '')
    assert.equal(renderToStaticMarkup(<AnnouncementBanner announcements={[]} />), '')
  })

  test('several unread: one block with the count, a link to each, and the rest behind "more"', () => {
    const list = ['1', '2', '3', '4', '5'].map(n => mk(`a${n}`, `Title ${n}`)).concat(mk('r', 'Already read', true))
    const html = renderToStaticMarkup(<AnnouncementBanner announcements={list} />)
    assert.ok(html.includes('5 new announcements'))
    for (const n of ['1', '2', '3']) assert.ok(html.includes(`href="/announcements/a${n}"`))
    assert.ok(!html.includes('href="/announcements/a4"'), 'capped at three rows')
    assert.ok(html.includes('+2 more'))
    assert.ok(!html.includes('Already read'))
    assert.ok(!/role="dialog"|alertdialog/.test(html), 'no pop-ups')
  })
})

describe('AnnouncementBell', () => {
  test('counts unacknowledged announcements only', () => {
    const html = renderToStaticMarkup(<AnnouncementBell announcements={[mk('a', 'A'), mk('b', 'B'), mk('c', 'C', true)]} />)
    assert.ok(html.includes('aria-label="Announcements, 2 unread"'))
    assert.match(html, />2<\/span>/)
  })
  test('no badge when everything is read', () => {
    const html = renderToStaticMarkup(<AnnouncementBell announcements={[mk('c', 'C', true)]} />)
    assert.ok(html.includes('aria-label="Announcements"'))
    assert.ok(!html.includes('boe-announce-bell-count'))
  })
})
