/**
 * CURRENT STATUS, RENDERED: the section above the product list, its two new
 * cards, and the CSS that makes three columns become one without a sideways
 * scroll.
 *
 * What these hold to:
 *   * the section is headed `Current Status` and holds its three areas IN
 *     ORDER — Main PI, Design Files, Manufacturing Status;
 *   * it is READ-ONLY: no button, no input, no form anywhere in the two new
 *     cards;
 *   * no storage key ever reaches the markup;
 *   * an Order with nothing recorded says so in words rather than showing a
 *     blank somebody would read as "not started";
 *   * long client and order content wraps instead of widening a card;
 *   * the grid it shares with the workspace goes 3 → 2 → 1 and never scrolls.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderCurrentStatus.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  OrderCurrentStatus,
  OrderDesignFilesCard,
  OrderManufacturingCard,
} from './OrderStatusWorkspace'
import {
  CURRENT_STATUS_TITLE,
  DESIGN_DRAWINGS_NOTE,
  DESIGN_FILES_TITLE,
  DESIGN_IMAGES_LOADING,
  DESIGN_IMAGES_NONE,
  DESIGN_IMAGES_NO_SOURCE,
  DESIGN_IMAGES_UNAVAILABLE,
  MANUFACTURING_TITLE,
  MANUFACTURING_UNTRACKED_NOTE,
  describeDesignFiles,
  describeManufacturingStatus,
  type DesignImageSummary,
} from '@/lib/orders/orderCurrentStatus'
import { approvalStanding, type PersistedApprovalEvent } from '@/lib/orders/orderApprovals'
import { describeProductionAlignment } from '@/lib/orders/productionAlignment'

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
const page = readFileSync(join(process.cwd(), 'src/app/orders/[id]/page.tsx'), 'utf8')

const events = (rows: Partial<PersistedApprovalEvent>[] = []): PersistedApprovalEvent[] =>
  rows.map((over, i) => ({
    id: `e${i}`, order_id: 'o1',
    approval_kind: 'fabric', status: 'fully_approved',
    evidence_path: null, actor_id: 'u1', created_at: '2026-09-01',
    ...over,
  }) as PersistedApprovalEvent)

const design = (over: {
  rows?: Partial<PersistedApprovalEvent>[]
  /** The picture read's state. Defaults to a finished, clean, empty read. */
  images?: DesignImageSummary
  representative?: number
  customization?: number
  productCount?: number
} = {}) => describeDesignFiles({
  approvals: approvalStanding({ events: events(over.rows ?? []), formatWhen: v => v }),
  images: over.images ?? {
    kind: 'ready',
    counts: {
      representative: over.representative ?? 0,
      customization: over.customization ?? 0,
    },
  },
  productCount: over.productCount ?? 0,
})

const manufacturing = (over: { aligned?: boolean; status?: string; label?: string } = {}) =>
  describeManufacturingStatus({
    production: describeProductionAlignment({
      alignment: over.aligned ? 'aligned' : 'not_aligned',
      alignedByName: over.aligned ? 'Priya Nair' : null,
      alignedAt: over.aligned ? '12 Sep 2026' : null,
      note: null,
      orderStatus: over.status ?? 'running',
      canAlign: false,
    }),
    orderStatus: over.status ?? 'running',
    orderStatusLabel: over.label ?? 'Running',
  })

// ── The section ───────────────────────────────────────────────────────────────

describe('the Current Status section', () => {
  test('is headed, labelled, and holds its three areas in the agreed order', () => {
    const html = renderToStaticMarkup(
      <OrderCurrentStatus>
        <div>main pi</div>
        <OrderDesignFilesCard view={design()} />
        <OrderManufacturingCard view={manufacturing()} />
      </OrderCurrentStatus>,
    )
    assert.match(html, /class="order-current-status"/)
    assert.match(html, new RegExp(`aria-label="${CURRENT_STATUS_TITLE}"`))
    assert.match(html, /<h2 class="order-current-status-title">Current Status<\/h2>/)

    const body = text(html)
    assert.ok(body.indexOf('main pi') < body.indexOf(DESIGN_FILES_TITLE))
    assert.ok(body.indexOf(DESIGN_FILES_TITLE) < body.indexOf(MANUFACTURING_TITLE))
  })

  test('it borrows the workspace grid rather than declaring a second one', () => {
    const html = renderToStaticMarkup(<OrderCurrentStatus><div /></OrderCurrentStatus>)
    assert.match(html, /class="order-status-workspace"/)
  })

  test('it sits between the workspace and the product list, and is drawn once', () => {
    const at = (needle: string) => page.indexOf(needle)
    assert.ok(at('<OrderStatusWorkspace>') < at('<OrderCurrentStatus>'))
    assert.ok(at('<OrderCurrentStatus>') < at('className="order-products"'))
    assert.equal((page.match(/<OrderCurrentStatus>/g) ?? []).length, 1)
  })
})

// ── Read-only ─────────────────────────────────────────────────────────────────

describe('the two new cards are READ-ONLY, and provably so', () => {
  const cards = [
    renderToStaticMarkup(<OrderDesignFilesCard view={design({
      rows: [
        { approval_kind: 'fabric', status: 'fully_approved', evidence_path: 'orders/o1/fabric.png' },
        { approval_kind: 'finish', status: 'partially_approved', evidence_path: 'orders/o1/finish.png' },
      ],
      representative: 5, customization: 7, productCount: 5,
    })} />),
    renderToStaticMarkup(<OrderManufacturingCard view={manufacturing({ aligned: true })} />),
  ]

  test('neither draws a control of any kind', () => {
    for (const html of cards) {
      for (const control of ['<button', '<input', '<form', '<select', '<textarea', '<a ']) {
        assert.equal(html.includes(control), false, `${control} is drawn`)
      }
    }
  })

  test('no storage key and no signed URL reaches the markup', () => {
    for (const html of cards) {
      assert.equal(/orders\/o1\//.test(html), false)
      assert.equal(/\.png/.test(html), false)
      assert.equal(/token=|supabase\.co/.test(html), false)
    }
  })
})

// ── What the cards say ────────────────────────────────────────────────────────

describe('Design Files says what is on record and what is not', () => {
  test('the statuses are words as well as tints', () => {
    const html = renderToStaticMarkup(<OrderDesignFilesCard view={design({
      rows: [
        { approval_kind: 'fabric', status: 'fully_approved' },
        { approval_kind: 'finish', status: 'partially_approved' },
      ],
      representative: 3, customization: 1, productCount: 3,
    })} />)
    const body = text(html)
    assert.match(body, /Fabric Fully Approved/)
    assert.match(body, /Finish Partially Approved/)
    assert.match(body, /4 files/)
    assert.match(body, /3 representative · 1 customization · 3 product lines/)
  })

  test('an Order with no design record at all says so, and shows no blank', () => {
    const body = text(renderToStaticMarkup(<OrderDesignFilesCard view={design()} />))
    assert.match(body, /Fabric Not Approved/)
    assert.match(body, /Finish Not Approved/)
    assert.ok(body.includes(DESIGN_IMAGES_NONE))
    assert.ok(body.includes(DESIGN_DRAWINGS_NOTE))
  })

  test('the CAD line is muted rather than hidden', () => {
    const html = renderToStaticMarkup(<OrderDesignFilesCard view={design()} />)
    assert.match(html, /class="order-status-line order-status-line--muted"/)
    assert.ok(text(html).includes('CAD & drawings'))
  })
})

describe('the rendered picture line never turns a non-answer into a zero', () => {
  const rendered = (images: DesignImageSummary) =>
    text(renderToStaticMarkup(<OrderDesignFilesCard view={design({ images })} />))

  test('while the read is in flight it says Loading, NOT None recorded', () => {
    const body = rendered({ kind: 'loading' })
    assert.ok(body.includes(DESIGN_IMAGES_LOADING))
    assert.equal(body.includes(DESIGN_IMAGES_NONE), false)
  })

  test('a finished, clean, empty read says None recorded', () => {
    assert.ok(rendered({ kind: 'ready', counts: { representative: 0, customization: 0 } })
      .includes(DESIGN_IMAGES_NONE))
  })

  test('stored rows render the count', () => {
    const body = text(renderToStaticMarkup(
      <OrderDesignFilesCard view={design({ representative: 2, customization: 9, productCount: 2 })} />,
    ))
    assert.match(body, /11 files/)
    assert.match(body, /2 representative · 9 customization · 2 product lines/)
  })

  test('an Order with no source PI says so', () => {
    const body = rendered({ kind: 'no_source' })
    assert.ok(body.includes(DESIGN_IMAGES_NO_SOURCE))
    assert.equal(body.includes(DESIGN_IMAGES_NONE), false)
  })

  test('a failed or unreadable read says Unavailable', () => {
    const body = rendered({ kind: 'unavailable' })
    assert.ok(body.includes(DESIGN_IMAGES_UNAVAILABLE))
    assert.equal(body.includes(DESIGN_IMAGES_NONE), false)
  })

  test('each non-answer is drawn muted, so it never reads as a status', () => {
    for (const kind of ['loading', 'no_source', 'unavailable'] as const) {
      const html = renderToStaticMarkup(<OrderDesignFilesCard view={design({ images: { kind } })} />)
      const muted = (html.match(/order-status-line--muted/g) ?? []).length
      assert.equal(muted, 2, `${kind}: the picture line and CAD, and nothing else`)
    }
  })
})

// ── The page's own read states ────────────────────────────────────────────────

describe('the page moves the picture summary through named states, and clears everything between Orders', () => {
  const loader = page.slice(page.indexOf('const loadPiHandoff'), page.indexOf('const reloadActivity'))

  test('every PI load resets the WHOLE image state before it decides anything', () => {
    const reset = loader.indexOf("setPiImages(noPiImages({ kind: 'loading' }))")
    assert.ok(reset > 0, 'the load does not reset the image state')
    assert.ok(reset < loader.indexOf('if (!submissionId)'),
      'the reset must happen BEFORE the no-source branch, or a stale count survives it')
    assert.ok(reset < loader.indexOf('await Promise.all'),
      'and before the reads, so nothing from the last Order is on screen during them')
  })

  test('the reset is total — one helper returns all five fields, so none can be forgotten', () => {
    const helper = page.slice(page.indexOf('function noPiImages'), page.indexOf('function noPiImages') + 420)
    for (const field of ['representativeByRow', 'customizationByRow', 'unresolved', 'viewerItems', 'summary']) {
      assert.ok(helper.includes(field), `noPiImages does not clear ${field}`)
    }
    assert.match(helper, /representativeByRow: new Map\(\)/)
    assert.match(helper, /viewerItems: \[\]/)
  })

  test('BOTH early returns leave a named state and no counts from the last Order', () => {
    // No source PI.
    const noSource = loader.slice(loader.indexOf('if (!submissionId)'), loader.indexOf('await Promise.all'))
    assert.match(noSource, /setPiImages\(noPiImages\(\{ kind: 'no_source' \}\)\)/)

    // The submission row could not be read.
    const unavailable = loader.slice(loader.indexOf('if (subRes.error || !row)'))
    assert.match(unavailable.slice(0, 600), /setPiImages\(noPiImages\(\{ kind: 'unavailable' \}\)\)/)
  })

  test('a failed image read becomes `unavailable`, never a count of zero', () => {
    assert.match(loader, /summary: imagesRes\.error\s*\?\s*\{ kind: 'unavailable' \}\s*:\s*\{ kind: 'ready', counts: countDesignImages\(images\) \}/)
  })

  test('`ready` is reached from ONE place, and that place has the rows in hand', () => {
    assert.equal((page.match(/kind: 'ready'/g) ?? []).length, 1)
    assert.equal((page.match(/countDesignImages\(/g) ?? []).length, 1)
  })

  test('the initial state is `loading` — the page has read nothing when it first draws', () => {
    assert.match(page, /useState<PiImagesState>\(\(\) => noPiImages\(\{ kind: 'loading' \}\)\)/)
  })

  test('the card is fed the STATE, not a bare count', () => {
    assert.match(page, /images: piImages\.summary/)
    assert.equal(page.includes('piImages.counts'), false)
  })
})

describe('Manufacturing Status says only what is recorded', () => {
  test('an aligned Order names who aligned it, and the stage it is in', () => {
    const body = text(renderToStaticMarkup(
      <OrderManufacturingCard view={manufacturing({
        aligned: true, status: 'ready_for_dispatch', label: 'Ready for Dispatch',
      })} />,
    ))
    assert.match(body, /Production alignment Aligned/)
    assert.match(body, /Aligned by Priya Nair · 12 Sep 2026/)
    assert.match(body, /Order stage Ready for Dispatch/)
  })

  test('an unaligned Order says what it waits on, and never claims a stage it has no record of', () => {
    const body = text(renderToStaticMarkup(<OrderManufacturingCard view={manufacturing()} />))
    assert.match(body, /Production alignment Not Aligned/)
    assert.match(body, /Head of Manufacturing/)
    assert.ok(body.includes(MANUFACTURING_UNTRACKED_NOTE))
    for (const invented of ['In Production', 'QC Passed', 'Packed', 'Not Dispatched']) {
      assert.equal(body.includes(invented), false, `the card claims "${invented}"`)
    }
  })
})

// ── Responsive, and long content ──────────────────────────────────────────────

describe('nothing overflows, at any width or any length', () => {
  test('the shared grid goes three, two, one — and never scrolls sideways', () => {
    assert.match(css, /\.order-status-workspace \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
    assert.match(css, /@media \(max-width: 1180px\)[\s\S]*?\.order-status-workspace \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
    assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.order-status-workspace \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    assert.equal(/\.order-current-status \{[^}]*overflow-x/.test(css), false)
  })

  test('the full-width span is by POSITION IN ITS OWN ROW, so a row of two is unaffected', () => {
    // Two rows of cards share this grid and they are different lengths. A rule
    // naming nth-child(3) would span the third card of a row that has only two
    // — and leave the Current Status row unbalanced the moment it changed.
    assert.equal(css.includes('.order-status-workspace > .order-status-card:nth-child(3)'), false)
    assert.match(css, /\.order-status-workspace > \.order-status-card:last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1; \}/)
    assert.match(css, /\.order-status-workspace > \.order-status-card:last-child:nth-child\(odd\) \{ grid-column: auto; \}/)
  })

  test('every line of the new cards may wrap, and none of them may widen one', () => {
    for (const rule of ['.order-status-line-plain', '.order-status-line-detail']) {
      const block = css.slice(css.indexOf(rule), css.indexOf(rule) + 260)
      assert.match(block, /overflow-wrap: anywhere/, rule)
      assert.match(block, /min-width: 0/, rule)
    }
    assert.match(css.slice(css.indexOf('.order-status-line-value')), /flex-wrap: wrap/)
    assert.match(css.slice(css.indexOf('.order-current-status {')), /min-width: 0/)
  })

  test('a very long value wraps inside the card instead of being cut off', () => {
    const long = 'Kanchipuram-Handloom-Silk-With-Zari-Border-And-Contrast-Pallu-Extended'
    const html = renderToStaticMarkup(
      <OrderManufacturingCard view={manufacturing({ label: long })} />,
    )
    assert.ok(text(html).includes(long), 'the value is rendered whole')
    assert.equal(/text-overflow: ellipsis/.test(
      css.slice(css.indexOf('.order-status-line-plain'), css.indexOf('.order-status-line-plain') + 260),
    ), false, 'nothing truncates it')
  })
})
