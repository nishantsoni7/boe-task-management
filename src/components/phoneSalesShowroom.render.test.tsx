// Phones, content first (owner, 2026-11-05), Phase 3: Sales, Exhibition Leads,
// Vendors, Inventory, Showroom Admin, the public showroom pages, Samples,
// Reviews, SEO, Marketing and the Image Editor. Layout cannot be proven
// without a browser (the screenshots at 390px drove these changes); this pins
// the pieces and rules the phone layout depends on, and that a desktop keeps
// its own controls.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { PhoneMultiGroup, PhoneSheetButton, PhoneSheetField } from '@/components/ui/phoneSheet'
import { chartGeometry } from './customerReviews/ReviewCharts'
import { ProductRow } from '@/app/showroom-admin/products/ProductTable'
import type { ShowroomProduct } from '@/lib/types'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}
const globals = read('src/app/globals.css')
const phase3 = globals.slice(globals.indexOf('PHONE PHASE 3 — SALES, LEADS, SHOWROOM, REVIEWS, SEO, MARKETING'))

describe('the shared Filter sheet', () => {
  // The phone-only Filter button as Sales, Vendors and Reviews draw it.
  const p3 = {
    label: 'Filter', title: 'Filter',
    triggerClassName: 'boe-phone-only orders-phone-filter p3-filter', sheetClassName: 'orders-sheet p3-sheet',
  }
  test('closed: one phone-only Filter button with the count of filters set', () => {
    const html = renderToStaticMarkup(<PhoneSheetButton {...p3} badge={2} doneLabel="Show 3 leads" />)
    assert.ok(html.includes('boe-phone-only'), 'a desktop keeps its own filters')
    assert.ok(html.includes('aria-label="Filter, 2 set"'))
    assert.equal(html.includes('role="dialog"'), false)
  })

  test('open: groups, a page\'s own controls, and a result button that names the rows', () => {
    const html = renderToStaticMarkup(
      <PhoneSheetButton
        {...p3} badge={0} initiallyOpen doneLabel="Show 12 vendors" onClearAll={noop}
        groups={[{ id: 'sort', label: 'Sort', value: 'name', options: [{ value: 'name', label: 'Name' }, { value: 'last', label: 'Last visit' }], onChange: noop }]}
      >
        <PhoneMultiGroup id="area" label="Area" options={[{ value: 'A', label: 'Andheri' }, { value: 'B', label: 'Bandra' }]} value={['B']} onChange={noop} />
        <PhoneSheetField label="Month"><select aria-label="Month" /></PhoneSheetField>
      </PhoneSheetButton>,
    )
    assert.ok(html.includes('role="dialog"'))
    assert.ok(html.includes('p3-sheet'))
    const t = text(html)
    for (const word of ['Sort', 'Last visit', 'Area', 'Bandra', 'Month', 'Clear all', 'Show 12 vendors']) assert.ok(t.includes(word), word)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2, 'Name (sort) and Bandra (area)')
  })

  test('its options are 40px and its selects 44px', () => {
    assert.match(phase3, /\.p3-sheet \.orders-sheet-options button \{[^}]*min-height: 40px/)
    assert.match(phase3, /\.p3-sheet select[^{]*\{[^}]*min-height: 44px/)
  })
})

describe('Exhibition Leads: search and one Filters button; figures as chips', () => {
  const list = read('src/components/exhibitionLeads/LeadsListScreen.tsx')
  const css = read('src/components/exhibitionLeads/leads.module.css')
  const add = read('src/components/exhibitionLeads/addLead.module.css')
  test('the date window and the exhibition move into the Filters sheet on a phone', () => {
    assert.ok(list.includes('<div className={s.whenTools}>{whenControls()}</div>'))
    assert.ok(list.includes('<div className={s.sheetWhen}'))
    assert.match(css, /\.whenTools \{ display: contents; \}/, 'a desktop toolbar is unchanged')
    assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.whenTools \{ display: none; \}/)
    assert.match(css, /\.sheetWhen \{ display: none; \}/)
  })
  test('KPIs are one chip line and the scope sentence goes', () => {
    assert.match(css, /\.kpis \{\s*display: flex; gap: 6px; overflow-x: auto;/)
    assert.match(css, /\.scopeLine \{ display: none; \}/)
  })
  test('My Leads tiles are 56px and the Add Lead bar is a compact pill', () => {
    assert.match(add, /\.tile \{ min-height: 56px;/)
    assert.match(add, /\.fab \{\s*left: auto; right: 16px; min-height: 52px;/)
  })
})

describe('Sales', () => {
  test('Lead Master: Source in a Filter sheet, Add and Import behind the header +', () => {
    const src = read('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(src.includes('<PhoneSheetButton'))
    assert.ok(src.includes("label: 'Import from ClickUp'"))
    assert.ok(src.includes("label: 'Add lead'"))
    assert.ok(src.includes('className={`${s.headActions} ${s.phoneHide}`}'))
    assert.match(read('src/components/salesLeads/salesLeads.module.css'), /\.who \{ height: 40px;/)
  })
  test('Team: the filter rows become one line and a Filter sheet', () => {
    const src = read('src/components/salesLeads/TeamScreen.tsx')
    assert.ok(src.includes("{ id: 'market', label: 'Market'"))
    assert.match(read('src/components/salesLeads/salesPages.module.css'), /@media \(max-width: 767px\) \{\s*\.filters \{ display: none; \}/)
  })
})

describe('Vendors', () => {
  const css = read('src/components/vendors/vendors.module.css')
  test('list: search and one Filter button share a row; the pills hide', () => {
    const src = read('src/components/vendors/VendorListScreen.tsx')
    assert.ok(src.includes('<PhoneMultiGroup id="v-can" label="Expertise"'))
    assert.match(css, /\.searchRow \{ display: contents; \}/)
    assert.match(css, /\.searchRow \.filterBar > \*:not\(:global\(\.p3-filter\)\) \{ display: none; \}/)
  })
  test('activity: figures as chips, the by-person table as cards', () => {
    const src = read('src/components/vendors/ActivityScreen.tsx')
    assert.ok(src.includes('<PhoneTableCards className={`${s.tableScroll} p3-cardgrid`}>'))
    assert.ok(src.includes('className={`${s.kpis} ${s.kpiChips}`}'))
  })
  test('vendor page: no second copy of the name, 44px actions', () => {
    assert.match(css, /\.heroId \{ display: none; \}/)
    assert.match(css, /\.actionBtn \{ flex: 1 1 0; min-width: 0; min-height: 44px;/)
  })
})

describe('Showroom Admin', () => {
  const product = {
    id: 'p1', product_code: 'BOE-101', name: 'Oak chair', category: 'Chairs', mrp: 12500, is_active: true,
    images: [], image_url: null,
  } as unknown as ShowroomProduct

  test('a product row carries the card classes and a ⋯ menu with every action', () => {
    const html = renderToStaticMarkup(
      <table><tbody><ProductRow product={product} toggling={false} onEdit={noop} onToggle={noop} onPrintQr={noop} onDelete={noop} /></tbody></table>,
    )
    for (const c of ['sra-prow', 'sra-p-img', 'sra-p-name', 'sra-p-code', 'sra-p-mrp', 'sra-p-acts', 'sra-p-iconbtns']) assert.ok(html.includes(c), c)
    assert.ok(html.includes('aria-label="Actions for BOE-101"'))
    assert.match(phase3, /grid-template-areas: "img name name more" "img code cat more" "img status \. mrp"/)
    assert.match(phase3, /\.sra-ptable \.sra-p-iconbtns \{ display: none !important; \}/)
  })
  test('inquiries: stage chips scroll sideways; the QR button is short', () => {
    const src = read('src/app/showroom-admin/page.tsx')
    assert.ok(src.includes('className="sra-stage-tabs"'))
    assert.ok(src.includes('<span className="sra-qr-short" aria-hidden="true">My QR</span>'))
    assert.match(phase3, /\.sra-stage-tab \{ flex: none; min-height: 40px;/)
  })
  test('new and edit: the dimension grid is 2 × 2', () => {
    for (const p of ['src/app/showroom-admin/products/new/page.tsx', 'src/app/showroom-admin/products/[product_code]/edit/page.tsx']) {
      assert.ok(read(p).includes('className="sra-dims"'), p)
    }
    assert.match(phase3, /\.sra-dims \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) !important; \}/)
  })
})

describe('44px controls elsewhere', () => {
  test('public showroom, samples dispatch, image editor', () => {
    assert.ok(read('src/app/showroom/project-list/page.tsx').includes('className="shw-remove"'))
    assert.ok(read('src/app/showroom/product/[product_code]/page.tsx').includes('className="shw-qty"'))
    assert.ok(read('src/app/samples/dispatch/[id]/page.tsx').includes('className="smp-dispatch"'))
    assert.ok(read('src/app/image-editor/QueueList.tsx').includes('className="ie-remove"'))
    assert.match(phase3, /\.shw-qty \{ width: 44px !important; height: 44px !important; \}/)
    assert.match(phase3, /\.ie-remove \{ width: 44px !important; height: 44px !important; \}/)
  })
  test('inventory figures are one chip line', () => {
    assert.match(read('src/components/inventory/inventory.module.css'), /\.stat \{ flex: none; flex-direction: row;[^}]*min-height: 40px/)
  })
})

describe('Reviews', () => {
  test('My Reviews: a compact leaderboard card, one Submit, the list first', () => {
    assert.ok(read('src/components/customerReviews/ReviewsLeaderboardPanel.tsx').includes('className="crv-lb-compact"'))
    assert.ok(read('src/components/customerReviews/CustomReviewSubmissions.tsx').includes('crv-submit-inline'))
    assert.match(phase3, /\.crv-lb-full \{ display: none !important; \}/)
    assert.match(phase3, /\.crv-later \{ order: 1; \}/)
  })
  test('Reports: one Filter sheet, metric chips, the explanation behind a toggle', () => {
    const src = read('src/app/customer-reviews/ReportsScreen.tsx')
    assert.ok(src.includes('<details className="crv-info-phone">'))
    assert.ok(src.includes('className="crv-rfilters"'))
    assert.match(phase3, /\.crv-metric-note \{ display: none; \}/)
  })
  test('the daily chart is drawn at phone size on a phone, unchanged on a desktop', () => {
    assert.deepEqual(chartGeometry(31, 5, false), { W: 682, fontSize: 9, padL: 26, padB: 22, tickEvery: 5 })
    const phone = chartGeometry(31, 5, true)
    assert.equal(phone.W, 320)
    assert.ok(phone.fontSize >= 11)
    assert.ok(Math.ceil(31 / phone.tickEvery) <= 7, 'at most ~6 day labels')
  })
})

describe('SEO and Marketing', () => {
  test('one verdict panel everywhere; on a phone it is cut to two lines with More', () => {
    assert.ok(read('src/components/seo/SeoSixMonth.tsx').includes('<VerdictPanel'))
    const css = read('src/components/seo/sixMonth.module.css')
    assert.match(css, /\.moreBtn \{ display: none; \}/)
    assert.match(css, /-webkit-line-clamp: 2/)
    assert.match(css, /\.time \.dot \{ width: 20px; height: 20px; font-size: 12px;/)
  })
  test('campaigns are cards and overview figures chips', () => {
    assert.ok(read('src/components/meta/MetaCampaigns.tsx').includes('<PhoneTableCards'))
    assert.ok(read('src/components/meta/MetaOverview.tsx').includes('s.statChips'))
    assert.match(read('src/components/meta/meta.module.css'), /\.chip \{ min-height: 40px; \}/)
  })
})

// ── Phase 4: Sales, Leads, Showroom, Samples ────────────────────────────────
const phase4 = globals.slice(globals.indexOf('PHONE PHASE 4 — SALES, LEADS, SHOWROOM, SAMPLES'))
/** The rules from the first phone media query after a marker. */
const phoneBlock = (css: string, marker: string) => {
  const from = css.indexOf(marker)
  assert.ok(from >= 0, marker)
  return css.slice(css.indexOf('@media (max-width: 767px)', from))
}

describe('Phase 4: the globals block is phone-only', () => {
  test('outside a media query it only hides the phone-only pieces', () => {
    assert.ok(globals.includes('PHONE PHASE 4 — SALES, LEADS, SHOWROOM, SAMPLES'))
    const outside = phase4.replace(/@media \(max-width: 767px\) \{[\s\S]*?\n\}/g, '')
    for (const rule of outside.match(/[^{}]+\{[^{}]*\}/g) ?? []) assert.match(rule, /display: none/, rule.trim())
  })
})

describe('Phase 4: Samples', () => {
  const page = read('src/app/samples/page.tsx')
  const notif = read('src/app/samples/notifications/page.tsx')
  test('the status tabs are a row of chips above the list, using the drawer\'s onTabSelect', () => {
    assert.ok(page.includes('className="smp-phone-tabs"'))
    assert.ok(page.includes('onClick={() => selectTab(tab.key)}'))
    assert.ok(page.includes('onTabSelect={selectTab}'))
    assert.match(phase4, /\.smp-phone-tab \{[^}]*min-height: 40px/)
    assert.match(phase4, /\.smp-section-head \{ display: none !important; \}/)
  })
  test('a card is one column with the dates under the identity; buttons and fields 44px, fields 16px', () => {
    for (const c of ['smp-card-info', 'smp-card-left', 'smp-card-grid', 'smp-card-dates', 'smp-actbtn']) assert.ok(page.includes(`className="${c}"`), c)
    assert.match(phase4, /\.smp-card-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\) !important/)
    assert.match(phase4, /\.smp-card-body button \{ min-height: 44px; \}/)
    assert.match(phase4, /\.smp-card-body input, \.smp-card-body select \{ min-height: 44px; font-size: 16px !important; \}/)
    assert.match(phase4, /\.smp-refresh \{ width: 44px !important; height: 44px !important; \}/)
    assert.ok(read('src/components/layout/SamplesLayout.tsx').includes('className="smp-refresh"'))
  })
  test('notifications: icon tools on a phone (labels desktop-only) and a 44px row delete', () => {
    assert.ok(notif.includes('className="boe-notif-tools"'))
    assert.equal((notif.match(/className="boe-notif-tool"/g) ?? []).length, 3)
    assert.ok(notif.includes('aria-label="Mark all read"') && notif.includes('aria-label="Delete all"'))
    assert.equal((notif.match(/<span className="boe-desktop-only">/g) ?? []).length, 2)
    assert.match(phase4, /\.smp-notif-del \{ width: 44px !important; height: 44px !important; \}/)
  })
})

describe('Phase 4: Showroom Admin', () => {
  test('categories: a 44px field and "+", 44px icon buttons that keep their names, no tag picture', () => {
    const src = read('src/app/showroom-admin/categories/page.tsx')
    for (const label of ['Edit category', 'Delete category', 'Save', 'Cancel', 'Add Category']) assert.ok(src.includes(`aria-label="${label}"`), label)
    assert.match(phase4, /\.sra-cat-input \{ height: 44px !important; font-size: 16px !important;/)
    assert.match(phase4, /\.sra-cat-btn \{ width: 44px; height: 44px;/)
    assert.match(phase4, /\.sra-cat-icon \{ display: none !important; \}/)
  })
  test('inquiry: 12px labels, a 44px remove and back', () => {
    const src = read('src/app/showroom-admin/inquiry/[inquiryId]/page.tsx')
    assert.equal((src.match(/className="sra-inq-label"/g) ?? []).length, 2)
    assert.ok(src.includes('className="sra-inq-remove"') && src.includes('className="sra-inq-back"'))
    assert.match(phase4, /\.sra-inq-label \{ font-size: 12px !important;/)
  })
  test('my QR: on a phone screen (not print) no kicker or heading, full-width buttons, the link behind Copy link', () => {
    const src = read('src/app/showroom-admin/qr/page.tsx')
    assert.ok(src.includes('className="sra-qr-btn sra-qr-copy"'))
    assert.ok(src.includes('navigator.clipboard.writeText(qrUrl)'))
    assert.match(phase4, /@media screen \{[\s\S]*\.sra-qr-kicker, \.sra-qr-h1, \.sra-qr-url \{ display: none !important; \}/)
  })
})

describe('Phase 4: the public showroom', () => {
  test('join: 16px fields, the salesperson in the sentence, a sticky Start', () => {
    const src = read('src/app/showroom/join/page.tsx')
    assert.equal((src.match(/className="shw-join-input"/g) ?? []).length, 5)
    assert.ok(src.includes('<span className="shw-join-sp-line">With <strong>{salespersonName}</strong>. </span>'))
    assert.match(phase4, /\.shw-join-input \{ font-size: 16px !important; \}/)
    assert.match(phase4, /\.shw-join-submit \{\s*position: sticky;/)
  })
  test('scan: a 44px back; product: Add is a bar fixed to the bottom', () => {
    assert.ok(read('src/app/showroom/scan/page.tsx').includes('className="shw-back"'))
    assert.ok(read('src/app/showroom/product/[product_code]/page.tsx').includes('<div className="shw-add-bar">'))
    assert.match(phase4, /\.shw-back \{ width: 44px; height: 44px;/)
    assert.match(phase4, /\.shw-add-bar \{\s*position: fixed;/)
  })
})

describe('Phase 4: Sales', () => {
  const board = read('src/components/salesLeads/BoardScreen.tsx')
  const boardCss = read('src/components/salesLeads/leadBoard.module.css')
  test('the board: phone at 767px in the CSS and the JS, Call plus one ⋯ on a card, the queue a chip', () => {
    assert.equal(boardCss.includes('max-width: 700px'), false)
    assert.ok(board.includes("matchMedia('(max-width: 767px)')"))
    assert.equal(board.includes('700px'), false)
    assert.ok(board.includes('s.actMore') && board.includes('s.actsOpen'))
    assert.ok(board.includes('s.queueChip'))
    const phone = phoneBlock(boardCss, '/* ── Narrower')
    assert.ok(phone.includes('.acts > .act:not(.actCall):not(.actMore) { display: none; }'))
    assert.ok(phone.includes('.menuField select { height: 44px; font-size: 16px; }'))
    assert.ok(phone.includes('.menuItem { min-height: 44px; }'))
    assert.ok(phone.includes('.queueChip { display: inline-flex; flex: 0 0 auto; height: 40px;'))
    assert.ok(boardCss.includes('.actMore, .queueChip { display: none; }'), 'a desktop has neither')
  })
  test('import: 44px file remove, 40px per-day pills, the history explainer behind a tap', () => {
    const src = read('src/components/salesLeads/ImportScreen.tsx')
    assert.ok(src.includes('<details className={`${s.card} ${s.historyPhone}`}>'))
    const phone = phoneBlock(read('src/components/salesLeads/salesPages.module.css'), 'Phase 4): Import')
    assert.ok(phone.includes('.files button { width: 44px; height: 44px;'))
    assert.ok(phone.includes('.perDay button { height: 40px;'))
  })
  test('add lead: no repeated panel title on a phone, the Save bar fixed above the Sales bottom bar', () => {
    const phone = phoneBlock(read('src/components/salesLeads/salesLeads.module.css'), 'Phase 4): Add lead')
    assert.ok(phone.includes('.panelHead > div:first-child { display: none; }'))
    assert.ok(phone.includes('position: fixed; left: 0; right: 0; bottom: calc(60px'))
  })
})

describe('Phase 4: Exhibition Leads, Vendors, Inventory', () => {
  test('ranking: its own scope class (the explanation shows on a phone), the select in the body, day leaders as chips', () => {
    const src = read('src/components/exhibitionLeads/RankingScreen.tsx')
    assert.equal(src.includes('s.scopeLine'), false)
    assert.ok(src.includes('<div className={s.rankScope}>'))
    assert.ok(src.includes('<details className={s.scopeMore}>'))
    assert.ok(src.includes('s.rankExPhone') && src.includes('boe-desktop-only'))
    const phone = phoneBlock(read('src/components/exhibitionLeads/leads.module.css'), 'Phase 4): Ranking')
    assert.ok(phone.includes('.rankExPhone { display: block;'))
    assert.match(phone, /\.leaderDays \.leaderCard \{[^}]*min-height: 40px/)
  })
  test('exhibitions: Add is a 40px "+", Manage access is in the header ⋯', () => {
    const src = read('src/components/exhibitionLeads/ExhibitionsScreen.tsx')
    assert.ok(src.includes('className="boe-phone-only boe-header-icon boe-header-icon--add" aria-label="Add exhibition"'))
    assert.ok(src.includes('<PhoneHeaderMenu'))
    assert.ok(src.includes("router.push('/admin/control-center/permissions/modules?module=exhibition_leads')"))
  })
  test('my leads tile labels are 12px', () => {
    assert.ok(read('src/components/exhibitionLeads/addLead.module.css').includes('.tile .tileLabel { font-size: 12px; }'))
  })
  test('vendors: 44px fields, outcomes and links, a 44px photo-remove hit area, a borderless form', () => {
    const phone = read('src/components/vendors/vendors.module.css')
    const block = phone.slice(phone.indexOf('Phase 4 (Log visit'))
    for (const rule of ['.input, .select { min-height: 44px; }', '.outcome { min-height: 44px; }', '.tileX::after { content: ""; position: absolute; inset: -6px; }',
      '.addProp, .propRemove { min-height: 40px; }', '.tileTag { font-size: 12px; }', '.wrap { background: transparent; border: 0;']) assert.ok(block.includes(rule), rule)
  })
  test('inventory: the product page drops the back row and the repeated name; 12px price labels; 44px request links', () => {
    const phone = phoneBlock(read('src/components/inventory/inventory.module.css'), 'CONTENT FIRST (Phase 4)')
    for (const rule of ['.detailPad .back { display: none; }', '.titleRepeat { display: none; }', '.priceLabel { font-size: 12px; }', '.reqLink { min-height: 44px; }']) assert.ok(phone.includes(rule), rule)
  })
})
