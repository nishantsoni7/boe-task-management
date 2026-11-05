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
import { PhoneFilterSheet, PhoneMultiGroup, PhoneSheetField } from './phoneFilters/PhoneFilterSheet'
import { chartGeometry } from './customerReviews/ReviewCharts'
import { ProductRow } from '@/app/showroom-admin/products/ProductTable'
import type { ShowroomProduct } from '@/lib/types'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const noop = () => {}
const globals = read('src/app/globals.css')
const phase3 = globals.slice(globals.indexOf('PHONE PHASE 3 — SALES, LEADS, SHOWROOM, REVIEWS, SEO, MARKETING'))

describe('the shared Filter sheet', () => {
  test('closed: one phone-only Filter button with the count of filters set', () => {
    const html = renderToStaticMarkup(<PhoneFilterSheet activeCount={2} resultLabel="Show 3 leads" />)
    assert.ok(html.includes('boe-phone-only'), 'a desktop keeps its own filters')
    assert.ok(html.includes('aria-label="Filter, 2 set"'))
    assert.equal(html.includes('role="dialog"'), false)
  })

  test('open: groups, a page\'s own controls, and a result button that names the rows', () => {
    const html = renderToStaticMarkup(
      <PhoneFilterSheet
        activeCount={0} initiallyOpen resultLabel="Show 12 vendors" onClearAll={noop}
        groups={[{ id: 'sort', label: 'Sort', value: 'name', options: [{ value: 'name', label: 'Name' }, { value: 'last', label: 'Last visit' }], onChange: noop }]}
      >
        <PhoneMultiGroup id="area" label="Area" options={[{ value: 'A', label: 'Andheri' }, { value: 'B', label: 'Bandra' }]} value={['B']} onChange={noop} />
        <PhoneSheetField label="Month"><select aria-label="Month" /></PhoneSheetField>
      </PhoneFilterSheet>,
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
    assert.ok(src.includes('<PhoneFilterSheet'))
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
