/**
 * THE DESIGN RECORD, AS THE DOCUMENTS BOX STATES IT.
 *
 * This suite used to cover a Current Status section of two read-only cards.
 * The section is gone: the PI and the design files are two subsections of one
 * Documents box, the approvals they both summarised are stated once by the card
 * beside it, and the box's own structure is covered by
 * orderStatusWorkspace.render.test.tsx.
 *
 * WHAT IS LEFT HERE IS THE PART THAT DID NOT MOVE: the four-state picture read
 * PR #195 introduced, which the box inherited whole. These hold that loading is
 * never "none", a refused read is never "none", an empty read says so in its own
 * words, and the page still feeds the STATE rather than a bare count.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderCurrentStatus.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESIGN_IMAGES_LOADING,
  DESIGN_IMAGES_NONE,
  DESIGN_IMAGES_NO_SOURCE,
  DESIGN_IMAGES_UNAVAILABLE,
  MANUFACTURING_TITLE,
  type DesignImageSummary,
} from '@/lib/orders/orderCurrentStatus'
import { designFilesDocument } from '@/lib/orders/orderDocumentsPanel'

const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')

/** The page with its prose removed: these are about what it DOES. */
const code = page
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

const summary = (over: DesignImageSummary) => designFilesDocument(over, 4)

// ══ The four states ═══════════════════════════════════════════════════════════

describe('the picture read never turns a non-answer into a zero', () => {
  test('while the read is in flight it is LOADING, not none', () => {
    assert.equal(summary({ kind: 'loading' }).kind, 'loading')
  })

  test('a failed or refused read is UNAVAILABLE, not none', () => {
    const view = summary({ kind: 'unavailable' })
    assert.equal(view.kind, 'unavailable')
    assert.equal(view.kind === 'unavailable' && view.message, DESIGN_IMAGES_UNAVAILABLE)
    // It carries the sentence that stops somebody concluding there are none.
    assert.ok(view.kind === 'unavailable' && view.note.length > 0)
  })

  test('an Order with no source PI says THAT, in its own words', () => {
    const view = summary({ kind: 'no_source' })
    assert.equal(view.kind, 'empty')
    assert.equal(view.kind === 'empty' && view.message, DESIGN_IMAGES_NO_SOURCE)
    assert.notEqual(view.kind === 'empty' && view.message, DESIGN_IMAGES_NONE)
  })

  test('a finished, clean, empty read says None recorded', () => {
    const view = summary({ kind: 'ready', counts: { representative: 0, customization: 0 } })
    assert.equal(view.kind, 'empty')
    assert.equal(view.kind === 'empty' && view.message, DESIGN_IMAGES_NONE)
    // And nothing about it reads as a failure.
    assert.equal(view.kind === 'empty' && view.note, null)
  })

  test('stored rows become a count and its qualifier', () => {
    const view = designFilesDocument({ kind: 'ready', counts: { representative: 2, customization: 9 } }, 2)
    assert.equal(view.kind, 'ready')
    assert.equal(view.kind === 'ready' && view.summary, '11 files')
    assert.equal(view.kind === 'ready' && view.detail,
      '2 representative · 9 customization · 2 product lines')
  })

  test('one file is not pluralised, and neither is one product line', () => {
    const view = designFilesDocument({ kind: 'ready', counts: { representative: 1, customization: 0 } }, 1)
    assert.equal(view.kind === 'ready' && view.summary, '1 file')
    assert.ok(view.kind === 'ready' && view.detail.endsWith('1 product line'))
  })

  test('the four states are four different kinds, so none can be read as another', () => {
    const kinds = [
      summary({ kind: 'loading' }).kind,
      summary({ kind: 'unavailable' }).kind,
      summary({ kind: 'ready', counts: { representative: 0, customization: 0 } }).kind,
      designFilesDocument({ kind: 'ready', counts: { representative: 1, customization: 0 } }, 1).kind,
    ]
    assert.deepEqual(kinds, ['loading', 'unavailable', 'empty', 'ready'])
    assert.equal(new Set(kinds).size, 4)
    // The word the box draws while it waits is still the read's own.
    assert.equal(DESIGN_IMAGES_LOADING, 'Loading…')
  })
})

// ══ The page's own read states ════════════════════════════════════════════════

describe('the page moves the picture summary through named states, and clears everything between Orders', () => {
  const loader = code.slice(code.indexOf('const loadPiHandoff'), code.indexOf('const reloadActivity'))

  test('every PI load resets the WHOLE image state before it decides anything', () => {
    const reset = loader.indexOf("setPiImages(noPiImages({ kind: 'loading' }))")
    assert.ok(reset > 0, 'the load does not reset the image state')
    assert.ok(reset < loader.indexOf('if (!submissionId)'),
      'the reset must happen BEFORE the no-source branch, or a stale count survives it')
    assert.ok(reset < loader.indexOf('await Promise.all'),
      'and before the reads, so nothing from the last Order is on screen during them')
  })

  test('the reset is total — one helper returns all five fields, so none can be forgotten', () => {
    const helper = code.slice(code.indexOf('function noPiImages'), code.indexOf('function noPiImages') + 420)
    for (const field of ['representativeByRow', 'customizationByRow', 'unresolved', 'viewerItems', 'summary']) {
      assert.ok(helper.includes(field), `noPiImages does not clear ${field}`)
    }
  })

  test('BOTH early returns leave a named state and no counts from the last Order', () => {
    const noSource = loader.slice(loader.indexOf('if (!submissionId)'), loader.indexOf('await Promise.all'))
    assert.match(noSource, /setPiImages\(noPiImages\(\{ kind: 'no_source' \}\)\)/)
    const unavailable = loader.slice(loader.indexOf('if (subRes.error || !row)'))
    assert.match(unavailable.slice(0, 600), /setPiImages\(noPiImages\(\{ kind: 'unavailable' \}\)\)/)
  })

  test('a failed image read becomes `unavailable`, never a count of zero', () => {
    assert.match(loader, /summary: imagesRes\.error\s*\?\s*\{ kind: 'unavailable' \}\s*:\s*\{ kind: 'ready', counts: countDesignImages\(images\) \}/)
  })

  test('the box is fed the STATE, not a bare count', () => {
    assert.match(code, /designFilesDocument\(piImages\.summary, piProducts\.length\)/)
    assert.equal(code.includes('piImages.counts'), false)
  })
})

// ══ What left the page, and what did not ══════════════════════════════════════

describe('the Current Status section and its cards are gone', () => {
  const status = readFileSync(join(process.cwd(), 'src/app/orders/[id]/OrderStatusWorkspace.tsx'), 'utf8')

  test('neither read-only card exists any more', () => {
    for (const gone of ['OrderCurrentStatus', 'OrderDesignFilesCard', 'OrderManufacturingCard']) {
      assert.equal(status.includes('export function ' + gone), false, gone)
      assert.equal(code.includes(gone), false, gone + ' is still drawn')
    }
    assert.equal(/Current Status/i.test(code), false)
    assert.equal(/Manufacturing/i.test(code), false)
  })

  test('BUT THE MANUFACTURING DESCRIBER AND ITS TESTS ARE UNTOUCHED', () => {
    // A display was removed across two passes; the data and the rules behind it
    // were not, and the alignment this page DOES state still comes from the
    // same helper as before.
    const lib = readFileSync(join(process.cwd(), 'src/lib/orders/orderCurrentStatus.ts'), 'utf8')
    assert.ok(lib.includes('export function describeManufacturingStatus'))
    assert.equal(MANUFACTURING_TITLE, 'Manufacturing Status')
    assert.ok(readFileSync(join(process.cwd(), 'src/lib/orders/orderCurrentStatus.test.ts'), 'utf8')
      .includes('describeManufacturingStatus'))
    assert.ok(code.includes('describeProductionAlignment({'))
    assert.ok(code.includes('canAlignProduction'))
    assert.ok(code.includes('<ProductionAlignmentModal'))
  })

  test('and the styling of the removed cards went with them', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
    for (const cls of ['order-current-status', 'order-current-status-cards',
                       'order-status-workspace', 'order-status-lines', 'order-status-line']) {
      assert.equal(css.includes('.' + cls + ' {'), false, cls + ' is still styled')
    }
  })
})
