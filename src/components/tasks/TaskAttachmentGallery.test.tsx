/**
 * The Task Detail attachment gallery and image viewer, RENDERED.
 *
 * Static markup only (react-dom/server, as MyTaskViewTabs.test.tsx does): it
 * answers "what is in the tree" for 0, 1, many and mixed attachments. Effects
 * do not run, so no signing happens and the fake client is never called.
 *
 * Run:
 *   npx tsx --test src/components/tasks/TaskAttachmentGallery.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TaskAttachmentGallery } from './TaskAttachmentGallery'
import { TaskImageViewer } from './TaskImageViewer'
import { buildGalleryEntries } from '@/lib/tasks/taskGallery'

const supabase = {} as SupabaseClient
const row = (id: string, file_name: string, path: string) => ({ id, file_name, storage_path: path, url: '' })

const render = (rows: ReturnType<typeof row>[]) => renderToStaticMarkup(
  <TaskAttachmentGallery
    entries={buildGalleryEntries(null, rows)}
    taskTitle="Site visit"
    supabase={supabase}
    onOpenFile={() => {}}
  />,
)

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('TaskAttachmentGallery', () => {
  test('no attachments renders nothing', () => {
    assert.equal(render([]), '')
  })

  test('one image: a thumbnail, the count, and Download all images', () => {
    const html = render([row('a', 'gate.jpg', 't/1.jpg')])
    assert.equal(count(html, 'class="boe-task-gallery-thumb"'), 1)
    assert.match(html, />1 image</)
    assert.match(html, /Download all images/)
    assert.doesNotMatch(html, /boe-task-gallery-files/)
  })

  test('many images keep their order', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`r${i}`, `photo-${i + 1}.jpg`, `t/${i}.jpg`))
    const html = render(rows)
    assert.equal(count(html, 'class="boe-task-gallery-thumb"'), 8)
    assert.match(html, />8 images</)
    const order = [...html.matchAll(/Open image (\d) of 8: photo-(\d)\.jpg/g)].map(m => [m[1], m[2]])
    assert.deepEqual(order, Array.from({ length: 8 }, (_, i) => [String(i + 1), String(i + 1)]))
  })

  test('mixed: documents stay as file links, and are not in the grid', () => {
    const html = render([
      row('a', 'gate.jpg', 't/1.jpg'),
      row('b', 'quote.pdf', 't/2.pdf'),
      row('c', 'yard.png', 't/3.png'),
    ])
    assert.equal(count(html, 'class="boe-task-gallery-thumb"'), 2)
    assert.match(html, /2 images · 1 file/)
    assert.match(html, /boe-task-gallery-files/)
    assert.match(html, /quote\.pdf/)
  })

  test('documents only: no grid and no ZIP button', () => {
    const html = render([row('b', 'quote.pdf', 't/2.pdf')])
    assert.doesNotMatch(html, /boe-task-gallery-grid/)
    assert.doesNotMatch(html, /Download all images/)
    assert.match(html, /quote\.pdf/)
  })

  test('long filenames carry the full name as a title for the ellipsis', () => {
    const long = 'a-very-long-site-photo-name-that-will-not-fit-in-a-thumbnail-caption-2026-09-25.jpeg'
    const html = render([row('a', long, 't/1.jpeg')])
    assert.match(html, new RegExp(`title="${long}"`))
  })
})

describe('TaskImageViewer', () => {
  const entries = buildGalleryEntries(null, Array.from({ length: 8 }, (_, i) => row(`r${i}`, `p${i + 1}.jpg`, `t/${i}.jpg`)))
  const urls = new Map(entries.map(e => [e.path, `https://signed.example/${e.path}`]))

  test('shows "Image 3 of 8" and visible Previous/Next controls', () => {
    const html = renderToStaticMarkup(<TaskImageViewer images={entries} urls={urls} startIndex={2} onClose={() => {}} />)
    assert.match(html, />Image 3 of 8</)
    assert.match(html, /aria-label="Previous image"/)
    assert.match(html, /aria-label="Next image"/)
    assert.match(html, /role="dialog"/)
    assert.match(html, /src="https:\/\/signed\.example\/t\/2\.jpg"/)
  })

  test('a single image has no Previous/Next', () => {
    const html = renderToStaticMarkup(<TaskImageViewer images={entries.slice(0, 1)} urls={urls} startIndex={0} onClose={() => {}} />)
    assert.doesNotMatch(html, /Previous image/)
    assert.match(html, />Image 1 of 1</)
  })

  test('an unsigned image says so instead of rendering a broken <img>', () => {
    const html = renderToStaticMarkup(<TaskImageViewer images={entries} urls={new Map()} startIndex={0} onClose={() => {}} />)
    assert.match(html, /could not be loaded/)
    assert.doesNotMatch(html, /<img/)
  })
})

describe('Task Detail page wiring', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/tasks/[id]/page.tsx'), 'utf8').replace(/\r\n/g, '\n')

  test('the summary card no longer lists task attachments', () => {
    assert.doesNotMatch(page, /Task attachments — legacy single \+ new multi-file/)
  })

  test('the gallery is rendered once per layout: under Activity, or under the summary', () => {
    assert.equal(count(page, '<TaskAttachmentGallery'), 2)
    assert.match(page, /\{!isWideLayout && \(\n\s+<TaskAttachmentGallery/)
    assert.match(page, /\{isWideLayout && \(\n\s+<TaskAttachmentGallery/)
    const activity = page.indexOf('{isQuotation ? \'Quotation History\' : \'Activity\'}')
    const desktopSlot = page.indexOf('{isWideLayout && (\n            <TaskAttachmentGallery')
    const rightColEnd = page.indexOf('</div>{/* end right column */}')
    assert.ok(activity > 0 && desktopSlot > activity && desktopSlot < rightColEnd)
  })
})
