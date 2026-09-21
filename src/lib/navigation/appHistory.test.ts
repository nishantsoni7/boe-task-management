/**
 * Can an in-app Back control safely pop the browser's history?
 *
 * THE DEFECT. Task Detail's Back button was a bare `router.back()`. Opening a
 * task from a notification in a NEW TAB gives that tab no history of its own,
 * so the press did nothing at all and the page looked frozen — the same defect
 * Orders and Finance had before RecordBackLink.
 *
 * The fix must not break the ordinary case, where popping is exactly right: it
 * returns to the real previous page, restores that list's scroll through the
 * popstate its own hook listens for, and leaves no extra entry behind for the
 * browser's own Back to trip over. So the question is not "is there anything
 * behind us" but "is the thing behind us OURS".
 *
 * Run:
 *   npx tsx --test src/lib/navigation/appHistory.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canPopInAppHistory, noteDocumentEntry, hasInAppHistory, resetDocumentEntry } from './appHistory'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

describe('canPopInAppHistory', () => {
  test('a document that has pushed an entry of its own may pop', () => {
    // A list was open, the reader clicked a task: one push. Back returns there.
    assert.equal(canPopInAppHistory(1, 2), true)
    assert.equal(canPopInAppHistory(7, 9), true)
  })

  test('a document that has pushed nothing may not', () => {
    // The task IS the first page in this tab — a notification opened in a new
    // tab, a bookmark, a pasted link. There is nothing of ours behind it.
    assert.equal(canPopInAppHistory(1, 1), false)
  })

  test('entries that were already in the tab before BOE loaded do not count', () => {
    // The reader visited another site, then typed a BOE task URL. There IS
    // something behind us — it is simply not ours, and an in-app Back that
    // popped into it would take the reader off BOE entirely.
    assert.equal(canPopInAppHistory(3, 3), false)
  })

  test('an unsampled document refuses — it cannot prove the entry behind it is ours', () => {
    assert.equal(canPopInAppHistory(null, 9), false)
    assert.equal(canPopInAppHistory(null, 1), false)
  })

  test('a capped history length refuses rather than popping off BOE', () => {
    // Chrome caps history.length at 50. Past the cap the number stops growing,
    // so a genuine in-app push is indistinguishable from none — and the safe
    // direction to fail in is "navigate to a named list", never a dead button
    // and never a jump off BOE.
    assert.equal(canPopInAppHistory(50, 50), false)
  })
})

describe('the document entry is sampled once, at boot', () => {
  beforeEach(() => resetDocumentEntry())

  test('the FIRST sample is the one that describes the document as it arrived', () => {
    noteDocumentEntry(4)
    noteDocumentEntry(9)   // a later call must not move the baseline forward
    assert.equal(canPopInAppHistory(4, 5), true)
    // If the second call had won, a document sitting at length 5 would look as
    // though it had pushed nothing.
    assert.equal(canPopInAppHistory(9, 5), false)
  })

  test('with no window there is no in-app history to pop', () => {
    // Server rendering, and any caller running before Providers has mounted.
    assert.equal(hasInAppHistory(), false)
  })
})

describe('the sample is taken at the root of every route', () => {
  const providers = read('src/components/layout/Providers.tsx')

  test('Providers records it, before the reader can navigate anywhere', () => {
    assert.ok(providers.includes("import { noteDocumentEntry } from '@/lib/navigation/appHistory'"))
    assert.ok(providers.includes('useEffect(() => { noteDocumentEntry(window.history.length) }, [])'))
  })

  test('the module it imports stays dependency-free', () => {
    // Providers is in the bundle every route loads. A history helper that
    // dragged Supabase or the permission resolver in with it would undo the
    // bundle split the permission context comment in that file describes.
    const src = read('src/lib/navigation/appHistory.ts')
    assert.equal(/^\s*import\s/m.test(src), false, 'appHistory.ts must import nothing')
  })
})
