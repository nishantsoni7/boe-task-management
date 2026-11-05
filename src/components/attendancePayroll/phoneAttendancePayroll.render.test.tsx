// Phones, content first — Attendance & Payroll and the staff pages (owner,
// 2026-11-05). Pins what a phone user sees first on each page and that every
// action the desktop has is still reachable on a phone.
//
// The server render covers the pieces that draw without data (the sheet, the
// header menu, the requests summary); the pages fetch on mount, so for them the
// test reads the source, the way the module's other screen tests do.

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PhoneSheet as Sheet } from './PhoneSheet'
import type { HeaderActions as Actions } from './HeaderActions'
import type { MyAttendanceRequests as Requests } from '@/components/attendanceRequests/MyAttendanceRequests'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

let PhoneSheet: typeof Sheet
let HeaderActions: typeof Actions
let MyAttendanceRequests: typeof Requests

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  PhoneSheet = (await import('./PhoneSheet')).PhoneSheet
  HeaderActions = (await import('./HeaderActions')).HeaderActions
  MyAttendanceRequests = (await import('@/components/attendanceRequests/MyAttendanceRequests')).MyAttendanceRequests
})

/** The text of every `@media (max-width: 767px)` block in a stylesheet. */
function phoneRules(css: string): string {
  const out: string[] = []
  const re = /@media \(max-width: 767px\) \{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    let depth = 1, i = m.index + m[0].length
    while (depth > 0 && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++ }
    out.push(css.slice(m.index, i))
  }
  return out.join('\n')
}

describe('the shared phone pieces', () => {
  test('PhoneSheet: a phone-only trigger with its count, and a sheet holding the page controls', () => {
    const closed = renderToStaticMarkup(
      <PhoneSheet label="Filter" badge={2} title="Filter and sort"><input aria-label="From" /></PhoneSheet>,
    )
    assert.match(closed, /class="orders-phone-filter phoneOnly sheetTrigger is-set"/)
    assert.match(closed, /aria-label="Filter, 2 set"/)
    assert.equal(closed.includes('role="dialog"'), false, 'closed until pressed')

    const open = renderToStaticMarkup(
      <PhoneSheet label="Filter" title="Filter records" doneLabel="Search" onClear={() => {}} initiallyOpen>
        <input aria-label="From" />
      </PhoneSheet>,
    )
    assert.match(open, /role="dialog" aria-modal="true" aria-label="Filter records"/)
    assert.match(open, />Clear all</)
    assert.match(open, /aria-label="From"/)
    assert.match(open, /orders-sheet-apply">Search</)
  })

  test('HeaderActions: the desktop buttons unchanged, the same actions in the phone menu', () => {
    const html = renderToStaticMarkup(
      <HeaderActions items={[{ key: 'r', label: 'Salary Processing Report', onSelect: () => {} }]}>
        <a href="/x">Salary Processing Report</a>
      </HeaderActions>,
    )
    assert.match(html, /<span class="boe-desktop-only" style="display:contents"><a href="\/x">/)
    assert.match(html, /class="boe-phone-only boe-header-icon"/)
    assert.match(html, /aria-label="More actions"/)
  })
})

describe('/my-attendance', () => {
  test('the requests are one line with New request; the list folds until asked for', () => {
    const html = renderToStaticMarkup(<MyAttendanceRequests getToken={async () => null} />)
    assert.match(html, /class="myRequestsToggle" aria-expanded="false" aria-controls="my-requests-list"/)
    assert.match(html, /<span class="boe-phone-only">New request<\/span>/)
    assert.match(html, /<span class="boe-desktop-only">Attendance request<\/span>/)
    const src = read('src/components/attendanceRequests/MyAttendanceRequests.tsx')
    assert.ok(src.includes("const foldClass = phoneOpen ? '' : ` ${styles.phoneFolded}`"))
    assert.ok(src.includes('queueMicrotask(() => setPhoneOpen(true))'), '#my-requests opens the list')
  })

  test('the month is compact, Refresh is the header one, the notes are one line', () => {
    const src = read('src/app/my-attendance/page.tsx')
    assert.ok(src.includes('const { refreshKey } = useRefresh()'), 'the header Refresh reloads the month')
    assert.ok(src.includes('<details className={styles.phoneNotes}>'))
    assert.ok(src.includes('styles.dayCard'))
    const css = phoneRules(read('src/app/my-attendance/myAttendance.module.css'))
    assert.match(css, /\.refresh, \.monthEcho \{ display: none !important; \}/)
    assert.match(css, /\.desktopNotice \{ display: none; \}/)
  })
})

describe('/my-payroll and the payslip', () => {
  test('a card per month, the whole row opens the payslip; no 620px table on a phone', () => {
    const src = read('src/app/my-payroll/page.tsx')
    assert.ok(src.includes('<div className={ui.desktopOnly} style={{ overflowX: \'auto\' }}>'))
    assert.ok(src.includes('className={styles.payRow}'))
    assert.ok(src.includes('onClick={() => router.push(`/my-payroll/${r.period_id}`)}'))
    assert.ok(src.includes('canRaiseIssue') && src.includes('raiseActionLabel'), 'Raise again stays')
    const css = phoneRules(read('src/app/my-payroll/myPayroll.module.css'))
    assert.match(css, /\.payRow \{[^}]*min-height: 60px/)
    assert.match(css, /\.back \{ min-height: 44px;/)
    assert.match(css, /\.panelBtn \{ min-height: 44px;/)
    assert.match(css, /\.detail :global\(\.payroll-identity-card\) > div:first-child \{ display: none !important; \}/)
  })

  test('the payslip workspace: 44px controls and a one-line identity card', () => {
    const css = phoneRules(read('src/app/payroll/results/payrollResultsPhone.module.css'))
    assert.match(css, /\.detail button:not\(\[title="How was this calculated\?"\]\) \{ min-height: 44px; \}/)
    assert.match(css, /\.pickRow td \{ height: 52px;/)
    const report = read('src/app/payroll/results/[periodId]/salary-report/page.tsx')
    assert.ok(report.includes('onClick={() => toggleOne(r.employee_id)}'), 'the whole row toggles')
    assert.ok(report.includes('onClick={e => e.stopPropagation()}'), 'the box does not toggle twice')
  })
})

describe('admin pages', () => {
  test('ObjectionQueue: cards on a phone, 44px Resolve / Reject / History', () => {
    const src = read('src/components/objections/ObjectionQueue.tsx')
    assert.ok(src.includes('<div className={styles.desktopOnly} style={{ overflowX: \'auto\' }}>'))
    assert.ok(src.includes('<ul className={styles.cards} aria-label={title}>'))
    assert.equal((src.match(/\{actions\(r\)\}/g) ?? []).length, 2, 'the same actions on both layouts')
    assert.match(phoneRules(read('src/components/objections/objectionQueue.module.css')), /\.action \{ min-height: 44px;/)
  })

  test('Monthly Preview: one notes line, the month on one row', () => {
    const src = read('src/app/payroll/monthly-review/page.tsx')
    assert.ok(src.includes('<details className={styles.phoneNotes}>'))
    assert.ok(src.includes('styles.monthBar'))
    assert.match(phoneRules(read('src/app/payroll/monthly-review/preview.module.css')), /\.cardLink::after \{ content: ''; position: absolute; inset: 0; \}/)
  })

  test('BOE Credits: balances first, settings folded behind one row', () => {
    const css = phoneRules(read('src/app/payroll/credits/credits.module.css'))
    assert.match(css, /\.balances \{ order: 1; \}/)
    assert.match(css, /\.settings \{ order: 4; \}/)
    assert.ok(read('src/app/payroll/credits/page.tsx').includes('aria-controls="credit-settings"'))
  })

  test('one employee\'s month: KPI chips and a card per day', () => {
    const src = read('src/app/attendance/monthly-review/[userId]/page.tsx')
    assert.ok(src.includes('<ul className={`${ui.cards} ${styles.days}`}'))
    const css = phoneRules(read('src/app/attendance/monthly-review/[userId]/employeeMonth.module.css'))
    assert.match(css, /\.kpis \{[^}]*overflow-x: auto/)
  })

  test('Incoming Minop, Records, Holidays: search + Filter sheet, list first', () => {
    const incoming = read('src/app/attendance/minop/incoming/page.tsx')
    assert.ok(incoming.includes('label="Filter"') && incoming.includes('label="Download"'))
    assert.match(phoneRules(read('src/app/attendance/minop/incoming/incoming.module.css')), /\.controls \{ display: none; \}/)
    const records = read('src/app/attendance/records/page.tsx')
    assert.ok(records.includes("onDone={() => { if (!fetching) void handleSearch() }}"))
    assert.ok(records.includes('${ui.desktopOnly}`}'), 'the desktop form is untouched, hidden on a phone')
    const holidays = read('src/app/attendance/holidays/page.tsx')
    assert.ok(holidays.includes('styles.phoneFolded') && holidays.includes('kind="add"'))
  })

  test('Overview: the tiles are one chip row; the month leaves the header', () => {
    const css = phoneRules(read('src/app/attendance/overview.module.css'))
    assert.match(css, /\.tiles \{[^}]*overflow-x: auto/)
    const page = read('src/app/attendance/page.tsx')
    assert.ok(page.includes('idPrefix="overview-month-phone"'))
  })

  test('the payroll guide tables stack instead of scrolling sideways', () => {
    const css = phoneRules(read('src/app/payroll/how-it-works/guidePhone.module.css'))
    assert.match(css, /\.stack table \{ display: block; min-width: 0 !important;/)
    assert.equal((read('src/app/payroll/how-it-works/page.tsx').match(/phone\.stack/g) ?? []).length, 2)
  })
})
