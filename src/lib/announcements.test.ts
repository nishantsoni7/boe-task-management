// Announcements — the pure rules the screens share.
// Run: npx tsx --test src/lib/announcements.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  indiaDate, addDays, defaultAnnouncementWindow, announcementStatus, bannerContent,
  validateAnnouncementPdf, buildAnnouncementPdfPath, announcementErrorMessage,
  validateAnnouncementDraft, ANNOUNCEMENT_BANNER_MAX_ROWS, type MyAnnouncement,
} from './announcements'

const mk = (id: string, read = false): MyAnnouncement => ({
  id, title: `T${id}`, summary: `S${id}`, body: 'b', starts_on: '2026-10-01', ends_on: '2026-10-15',
  attachment_path: null, attachment_name: null, attachment_size: null,
  created_at: '2026-10-01T00:00:00Z', read_at: read ? '2026-10-02T00:00:00Z' : null,
})

describe('India dates', () => {
  test('the day turns at IST midnight (18:30 UTC), not UTC midnight', () => {
    assert.equal(indiaDate(new Date('2026-10-09T18:29:59Z')), '2026-10-09')
    assert.equal(indiaDate(new Date('2026-10-09T18:30:00Z')), '2026-10-10')
  })

  test('a new announcement defaults to 15 days, counting the start day', () => {
    const w = defaultAnnouncementWindow(new Date('2026-09-25T05:00:00Z'))
    assert.deepEqual(w, { startsOn: '2026-09-25', endsOn: '2026-10-09' })
  })

  test('addDays crosses month ends', () => {
    assert.equal(addDays('2026-09-30', 1), '2026-10-01')
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  })
})

describe('status — the same rule as announcement_is_live', () => {
  const a = { starts_on: '2026-10-01', ends_on: '2026-10-15', ended_at: null }
  test('both ends inclusive', () => {
    assert.equal(announcementStatus(a, '2026-10-01'), 'active')
    assert.equal(announcementStatus(a, '2026-10-15'), 'active')
  })
  test('before, after and ended early', () => {
    assert.equal(announcementStatus(a, '2026-09-30'), 'scheduled')
    assert.equal(announcementStatus(a, '2026-10-16'), 'expired')
    assert.equal(announcementStatus({ ...a, ended_at: '2026-10-05T10:00:00Z' }, '2026-10-05'), 'ended')
  })
})

describe('the banner shows unread only, compactly', () => {
  test('nothing when everything is acknowledged', () => {
    assert.equal(bannerContent([mk('1', true), mk('2', true)]).unread.length, 0)
  })
  test('several unread become one block of at most three rows plus a count of the rest', () => {
    const c = bannerContent([mk('1'), mk('2', true), mk('3'), mk('4'), mk('5'), mk('6')])
    assert.equal(c.unread.length, 5)
    assert.equal(c.shown.length, ANNOUNCEMENT_BANNER_MAX_ROWS)
    assert.equal(c.more, 2)
    assert.ok(c.shown.every(a => !a.read_at))
  })
})

describe('the PDF', () => {
  test('mirrors the bucket: PDF only, non-empty, under 10 MB', () => {
    assert.equal(validateAnnouncementPdf({ name: 'g.pdf', size: 1000, type: 'application/pdf' }), null)
    assert.equal(validateAnnouncementPdf({ name: 'G.PDF', size: 1000, type: '' }), null)
    assert.match(validateAnnouncementPdf({ name: 'g.pdf', size: 0, type: 'application/pdf' })!, /empty/)
    assert.match(validateAnnouncementPdf({ name: 'g.pdf', size: 10 * 1024 * 1024 + 1, type: 'application/pdf' })!, /10 MB/)
    assert.match(validateAnnouncementPdf({ name: 'g.docx', size: 10, type: 'application/msword' })!, /Only PDF/)
    // An extension cannot launder a reported non-PDF type.
    assert.match(validateAnnouncementPdf({ name: 'g.pdf', size: 10, type: 'image/png' })!, /Only PDF/)
  })

  test('the object key has the shape the storage policies accept', () => {
    const id = '0f6692f7-1111-4222-8333-444455556666'
    const path = buildAnnouncementPdfPath(id)
    // The same pattern as public.announcement_file_announcement_id().
    assert.match(path, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+\.pdf$/)
    assert.ok(path.startsWith(`${id}/`))
  })
})

describe('errors and form validation', () => {
  test('the database message is shown; anything else is generic', () => {
    assert.equal(
      announcementErrorMessage({ message: 'ANNOUNCEMENT_NO_RECIPIENTS: choose at least one person to show this announcement to' }),
      'choose at least one person to show this announcement to')
    assert.equal(announcementErrorMessage({ message: 'duplicate key value violates…' }, 'X'), 'X')
    assert.equal(announcementErrorMessage(null, 'X'), 'X')
  })

  const ok = { title: 't', summary: 's', body: 'b', startsOn: '2026-10-01', endsOn: '2026-10-15', recipientIds: ['u'] }
  test('a complete draft passes', () => {
    assert.equal(validateAnnouncementDraft(ok, '2026-10-01'), null)
  })
  test('named recipients are required — it is never shown to everyone by default', () => {
    assert.match(validateAnnouncementDraft({ ...ok, recipientIds: [] }, '2026-10-01')!, /at least one person/)
  })
  test('dates: end before start, and a past end unless editing', () => {
    assert.match(validateAnnouncementDraft({ ...ok, endsOn: '2026-09-30' }, '2026-09-01')!, /on or after/)
    assert.match(validateAnnouncementDraft(ok, '2026-10-16')!, /already passed/)
    assert.equal(validateAnnouncementDraft(ok, '2026-10-16', { allowPastEnd: true }), null)
  })
})
