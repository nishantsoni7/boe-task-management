/**
 * The two PI screens, in a REAL browser, measured in pixels.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TESTS
 * -----------------------------------------
 * src/app/orders/piSectionOrder.test.ts parses the JSX tree and proves the
 * sections are siblings in the right order. That catches everything a static
 * reading can catch — including a section nested inside the card it is supposed
 * to precede, which a `source.indexOf(a) < source.indexOf(b)` guard cannot see.
 *
 * What it cannot do is look. This can: it drives Chromium against a real dev
 * server and compares the on-screen Y positions of the Payments card, the
 * ready-to-submit card and the FIRST PRODUCT ROW, at desktop and phone widths.
 * If CSS, a stacking context or a stale build ever put a product row above
 * either section, this is what would say so.
 *
 * It is not part of `npm test` because it needs a browser and a running server.
 * Run it when the arrangement of these screens changes, or when a screenshot
 * disagrees with the tests — which usually means the server under the
 * screenshot was not running the branch under discussion.
 *
 * NOTHING REAL IS TOUCHED. Supabase is stubbed at the network layer with
 * invented figures; no project URL, key, client, price or photograph is read.
 * The session cookie is a fabricated value this script makes up, accepted only
 * because the stub answers every request.
 *
 * Usage:
 *   npm i --no-save playwright-core
 *   printf 'NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co\n%s\n' \
 *     'NEXT_PUBLIC_SUPABASE_ANON_KEY=stub-anon-key' > .env.local
 *   npx next dev -p 3000 &
 *   node scripts/verify-pi-section-order.mjs [--workbook path/to/sample.xlsx]
 *
 * The New Order preview only exists once a workbook has been read, so that page
 * is checked only when --workbook names one. Any BOE-template .xlsx will do;
 * src/lib/pi/masterSheetParser.test.ts builds synthetic ones.
 *
 * Exits non-zero if any section is not where it must be.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')

const BASE = process.env.PI_VERIFY_BASE_URL ?? 'http://localhost:3000'
const CHROME = process.env.PI_VERIFY_CHROMIUM
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

const workbookFlag = process.argv.indexOf('--workbook')
const WORKBOOK = workbookFlag === -1 ? null : process.argv[workbookFlag + 1]

const SUB_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

const failures = []
const ok = (label, condition, detail) => {
  if (condition) console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`)
  else { console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); failures.push(label) }
}

// ── Invented data ─────────────────────────────────────────────────────────────

const submission = {
  id: SUB_ID, status: 'submitted', client_name: 'Acme Furnishings Pvt Ltd',
  created_by: USER_ID, submitted_by: USER_ID, assigned_to: null,
  submitted_at: '2026-08-03T04:00:00Z', rejected_by: null, rejected_at: null,
  creation_date: '2026-08-01', source_created_by: 'R. Sharma',
  bill_to_name: 'Acme Furnishings, Mumbai', ship_to_name: 'Acme Warehouse, Bhiwandi',
  order_confirmation_date: null, dispatch_commitment: null,
  source_workbook_name: 'ACME-PI-0091.xlsx',
  gross_product_amount: '30000.00', discount_amount: '0.00',
  subtotal_after_discount: '30000.00',
  fabric_cost: null, fabric_cost_meaning: null, fabric_cost_text: null,
  packing_cost: null, packing_cost_meaning: null, packing_cost_text: null,
  transportation_amount: null, transportation_text: null,
  total_before_gst: '30000.00', gst_amount: '3333.33', grand_total: '33333.33',
  parse_warnings: null, parse_blocking_issues: null, review_note: null,
  created_at: '2026-08-01T09:00:00Z', updated_at: '2026-08-03T04:00:00Z',
  approved_by: null, approved_at: null, order_id: null,
  finance_verified_by: null, finance_verified_at: null,
  finance_verified_grand_total: null, finance_verified_payment_amount: null,
  deletion_claim_token: null, advance_condition: 'standard',
  advance_exception_status: null, advance_exception_reason: null,
  advance_exception_requested_by: null, advance_exception_requested_at: null,
  advance_exception_decided_by: null, advance_exception_decided_at: null,
  advance_exception_rejection_reason: null,
}

const items = [1, 2, 3].map(n => ({
  id: `item-${n}`, source_row: 20 + n, item_sequence: String(n),
  product_name: `Oak Dining Chair, model ${n}`, quantity: 4,
  dimensions: '45 x 45 x 90 cm', material: 'Solid oak',
  customization: n === 2 ? 'Client logo engraved on backrest' : null,
  cost_per_piece: '2500.00', total_amount: '10000.00', sort_order: n,
}))

const paymentSummary = {
  submission_id: SUB_ID, submission_status: 'submitted',
  grand_total: '33333.33', verified_amount: '10000.00', unverified_amount: '0.00',
  verified_percent: '30.00', unverified_percent: '0.00',
  needed_for_standard: '3333.33', required_payment: '13333.33',
  meets_standard: false, approval_position: 'advance_short',
  pending_balance: '23333.33', standard_percent: 40,
  exception_status: null, exception_current: null, exception_reason: null,
  exception_rejection_reason: null,
  payment_terms: '40% advance against PI', billing_terms: 'Ex-works Bhiwandi',
  can_view_all_finance: true,
  payments: [{
    allocation_id: 'alloc-1', allocation_status: 'active',
    allocated_amount: '10000.00', payment_id: 'pay-1',
    request_number: 'PR-2026-0044', amount: '10000.00',
    payment_date: '2026-08-02', payment_mode: 'bank_transfer',
    reference: 'UTR-4471902', remarks: null, status: 'verified',
    is_verified: true, admin_note: null, entered_by: 'R. Sharma',
    verified_by: 'F. Officer', created_at: '2026-08-02T06:00:00Z',
    verified_at: '2026-08-02T11:00:00Z', rejected_at: null,
    proof_count: 1, can_view_proof: true,
  }],
}

const profile = {
  id: USER_ID, full_name: 'R. Sharma', email: 'r.sharma@example.com',
  role: 'admin', is_active: true, department: 'Sales', designation: 'Executive',
  employee_code: 'EMP-001', reporting_manager_id: null, avatar_url: null,
  phone: null, date_of_joining: '2024-01-01',
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
}

const session = {
  access_token: 'stub-access-token', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'stub-refresh-token',
  user: {
    id: USER_ID, aud: 'authenticated', role: 'authenticated',
    email: 'r.sharma@example.com', app_metadata: {}, user_metadata: {},
    created_at: '2024-01-01T00:00:00Z',
  },
}

// ── Browser plumbing ──────────────────────────────────────────────────────────

const json = body => ({
  status: 200, contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
})

async function openPage(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  // @supabase/ssr keeps the session in a COOKIE, base64url behind a `base64-`
  // marker — not in localStorage.
  await ctx.addCookies([{
    name: 'sb-stub-auth-token',
    value: 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'),
    domain: 'localhost', path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
  }])

  await ctx.route('**stub.supabase.co/**', route => {
    const p = new URL(route.request().url()).pathname
    if (p.startsWith('/auth/v1/user')) return route.fulfill(json(session.user))
    if (p.startsWith('/auth/v1/token')) return route.fulfill(json(session))
    if (p.startsWith('/rest/v1/rpc/pi_submission_payment_summary')) return route.fulfill(json(paymentSummary))
    if (p.startsWith('/rest/v1/rpc/resolve_effective_permissions')) {
      return route.fulfill(json(['view', 'view_all', 'create', 'approve', 'approve_order',
        'manage', 'allocate', 'can_be_order_assignee', 'approve_advance_exception']))
    }
    if (p.startsWith('/rest/v1/rpc/')) return route.fulfill(json(null))
    if (p.startsWith('/rest/v1/order_submission_items')) return route.fulfill(json(items))
    if (p.startsWith('/rest/v1/order_submission_item_images')) return route.fulfill(json([]))
    if (p.startsWith('/rest/v1/order_submission_activity')) return route.fulfill(json([]))
    if (p.startsWith('/rest/v1/order_submissions')) return route.fulfill(json(submission))
    if (p.startsWith('/rest/v1/users')) {
      const accept = route.request().headers()['accept'] ?? ''
      return route.fulfill(json(accept.includes('vnd.pgrst.object') ? profile : [profile]))
    }
    if (p.startsWith('/storage/v1/')) return route.fulfill(json([]))
    return route.fulfill(json(null))
  })

  const page = await ctx.newPage()
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  return { page, ctx }
}

/** The document-relative top of the first element whose text matches. */
const topOfText = (page, text) => page.evaluate(t => {
  const els = [...document.querySelectorAll('div,span,th,td,p,h1,h2,h3,button')]
  const hit = els.find(e => e.textContent?.trim() === t && e.children.length === 0)
    ?? els.find(e => e.textContent?.trim().startsWith(t))
  return hit ? Math.round(hit.getBoundingClientRect().top + window.scrollY) : null
}, text)

/**
 * The document-relative top of the FIRST product line, whichever layout is on.
 *
 * The table becomes a stack of cards below the page's mobile breakpoint, so a
 * `tbody tr` probe alone would silently measure nothing on a phone — and a null
 * compares as "no evidence", not as "above". Both layouts are covered here so
 * the phone check is a real check.
 */
const topOfFirstProduct = (page, firstProductName) => page.evaluate(name => {
  const row = document.querySelector('tbody tr')
  if (row) return Math.round(row.getBoundingClientRect().top + window.scrollY)
  const el = [...document.querySelectorAll('p,div,span')]
    .find(e => e.textContent?.trim() === name && e.children.length === 0)
  return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null
}, firstProductName)

async function checkDetail(browser) {
  console.log('\nPI Draft detail — /orders/drafts/<id>')
  const { page, ctx } = await openPage(browser, `/orders/drafts/${SUB_ID}`)

  for (const [label, width] of [['desktop', 1440], ['phone', 390]]) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 })
    await page.waitForTimeout(700)
    const payments = await topOfText(page, 'Payments')
    const add = await topOfText(page, 'Add payment')
    const productsHead = await topOfText(page, 'Products')
    const firstRow = await topOfFirstProduct(page, 'Oak Dining Chair, model 1')

    console.log(`  ${label}: payments=${payments} addPayment=${add} `
      + `productsHead=${productsHead} firstProductRow=${firstRow}`)
    ok(`${label}: Payments is above the Products heading`,
      payments !== null && productsHead !== null && payments < productsHead)
    ok(`${label}: Payments is above the first product row`,
      payments !== null && firstRow !== null && payments < firstRow)
    ok(`${label}: the Add payment control is above the first product row`,
      add !== null && firstRow !== null && add < firstRow)
  }

  const count = await page.evaluate(() =>
    [...document.querySelectorAll('div')].filter(e => e.textContent?.trim() === 'Payments').length)
  ok('the Payments heading appears exactly once', count === 1, `found ${count}`)
  await ctx.close()
}

async function checkImport(browser) {
  console.log('\nNew Order — /orders/import')
  if (!WORKBOOK) {
    console.log('  SKIPPED — pass --workbook <file.xlsx> to check the upload preview')
    return
  }
  const { page, ctx } = await openPage(browser, '/orders/import')
  await page.setInputFiles('input[type=file]', WORKBOOK)
  await page.waitForTimeout(2500)

  for (const [label, width] of [['desktop', 1440], ['phone', 390]]) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 1100 })
    await page.waitForTimeout(700)
    const orderInfo = await topOfText(page, 'Order information')
    const ready = await topOfText(page, 'PI ready for submission')
    const save = await topOfText(page, 'Save Draft')
    const productsHead = await topOfText(page, 'Products')
    const firstRow = await topOfFirstProduct(page, 'Sample Item 1')

    console.log(`  ${label}: orderInfo=${orderInfo} ready=${ready} save=${save} `
      + `productsHead=${productsHead} firstProductRow=${firstRow}`)
    ok(`${label}: the ready card is below the order information`,
      orderInfo !== null && ready !== null && orderInfo < ready)
    ok(`${label}: the ready card is above the Products heading`,
      ready !== null && productsHead !== null && ready < productsHead)
    ok(`${label}: Save Draft is above the first product row`,
      save !== null && firstRow !== null && save < firstRow)
  }

  const count = await page.evaluate(() =>
    [...document.querySelectorAll('div')]
      .filter(e => e.textContent?.trim() === 'PI ready for submission').length)
  ok('the ready heading appears exactly once', count === 1, `found ${count}`)
  await ctx.close()
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
try {
  await checkDetail(browser)
  await checkImport(browser)
} finally {
  await browser.close()
}

console.log(failures.length === 0
  ? '\nAll section-order checks passed.'
  : `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
