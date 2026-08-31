/**
 * activityHeadings — behavioural tests
 *
 * The activity feed's sentence for a `note_added` row, which is the one row
 * type that can hold a comment, a set of files, or both.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/activityHeadings.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentPhrase, commentHeadingRest } from './activityHeadings'

describe('attachmentPhrase', () => {
  test('no files has no phrase', () => {
    assert.equal(attachmentPhrase([]), null)
  })

  test('one PDF is a document', () => {
    assert.equal(attachmentPhrase([{ fileType: 'PDF', name: 'quote.pdf' }]), 'a document')
  })

  test('two documents are counted', () => {
    assert.equal(
      attachmentPhrase([{ fileType: 'Word', name: 'a.docx' }, { fileType: 'Excel', name: 'b.xlsx' }]),
      '2 documents',
    )
  })

  test('one image is an image', () => {
    assert.equal(attachmentPhrase([{ fileType: 'Image', name: 'sample.jpg' }]), 'an image')
  })

  test('three images are counted', () => {
    const files = ['a.png', 'b.jpg', 'c.webp'].map(name => ({ fileType: 'Image', name }))
    assert.equal(attachmentPhrase(files), '3 images')
  })

  test('a mixed set is neutral — photos are not called documents', () => {
    assert.equal(
      attachmentPhrase([{ fileType: 'Image', name: 'a.png' }, { fileType: 'PDF', name: 'b.pdf' }]),
      '2 files',
    )
  })

  test('a row with no stored file_type is classified by its name', () => {
    assert.equal(attachmentPhrase([{ fileType: null, name: 'site-photo.HEIC' }]), 'an image')
    assert.equal(attachmentPhrase([{ fileType: null, name: 'invoice.pdf' }]), 'a document')
  })

  test('a storage path with a query string still classifies', () => {
    assert.equal(attachmentPhrase([{ name: 'tasks/9/photo.png?token=abc' }]), 'an image')
  })

  test('a MIME type is understood as well as the stored label', () => {
    assert.equal(attachmentPhrase([{ fileType: 'image/png' }]), 'an image')
  })

  test('an unknown file with no extension is a document, never a crash', () => {
    assert.equal(attachmentPhrase([{ fileType: null, name: null }]), 'a document')
  })
})

describe('commentHeadingRest', () => {
  test('text alone still reads "commented"', () => {
    assert.equal(commentHeadingRest('Please confirm the fabric', []), 'commented')
  })

  test('a file with no text says what was attached, not "commented"', () => {
    assert.equal(
      commentHeadingRest(null, [{ fileType: 'PDF', name: 'po.pdf' }]),
      'attached a document',
    )
  })

  test('whitespace-only text is not a comment', () => {
    assert.equal(
      commentHeadingRest('   \n  ', [{ fileType: 'Image', name: 'x.png' }]),
      'attached an image',
    )
  })

  test('text and a file are both reported', () => {
    assert.equal(
      commentHeadingRest('See attached', [{ fileType: 'PDF', name: 'po.pdf' }]),
      'commented and attached a document',
    )
  })

  test('an empty row yields nothing, so the caller keeps its own wording', () => {
    assert.equal(commentHeadingRest(null, []), null)
    assert.equal(commentHeadingRest('', []), null)
  })
})

// ── The two surfaces that must both use it ───────────────────────────────────
//
// The same event is described in two places — the task's activity feed and the
// notification card. They drifted before: the feed said "commented" and the
// card said "Comment added" for an update whose only content was a PDF. Both
// now read the phrase from this module.

describe('both surfaces read the phrase from here', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  test('the task activity feed derives the note_added sentence from the row', () => {
    const src = read('src/app/tasks/[id]/page.tsx')
    assert.ok(src.includes('commentHeadingRest'), 'the feed calls the shared helper')
    assert.equal(/case 'note_added':\s*return 'commented'/.test(src), false,
      'no unconditional "commented" may survive beside it')
  })

  test('the notification card is given the files the update carried', () => {
    const card = read('src/components/notifications/NotificationTaskGroup.tsx')
    assert.ok(/attachments:\s*detail\?\.attachments/.test(card),
      'the card passes the linked row attachments through')
    const presentation = read('src/lib/notifications/eventPresentation.ts')
    assert.ok(presentation.includes('attachmentPhrase'), 'and the phrase comes from here')
  })
})
