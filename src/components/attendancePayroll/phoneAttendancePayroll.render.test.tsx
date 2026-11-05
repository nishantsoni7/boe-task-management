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
    assert.ok(src.includes('<ul id={panelId} className={`${styles.cards}${phoneFold}`} aria-label={title}>'))
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

// ── Phase 4: every Attendance & Payroll page at 8.5 or better on a phone ─────

describe('Phase 4: attendance pages', () => {
  test('one employee: an identity line, Details folds the four sections, dates in a Filter sheet', () => {
    const src = read('src/app/attendance/employees/[id]/page.tsx')
    assert.ok(src.includes('aria-controls="employee-sections"'))
    assert.ok(src.includes("${detailsOpen ? '' : ` ${styles.phoneFolded}`}"))
    assert.ok(src.includes('<PhoneSheet') && src.includes('id="from-date-phone"') && src.includes('id="to-date-phone"'))
    assert.ok(src.includes('${ui.surface} ${ui.surfaceBody} ${ui.desktopOnly}'), 'the desktop date row is unchanged, hidden on a phone')
    const css = phoneRules(read('src/app/attendance/employees/[id]/detail.module.css'))
    assert.match(css, /\.back \{ min-height: 44px; \}/)
    assert.match(css, /\.detailsToggle \{[^}]*min-height: 44px/)
  })

  test('upload: one step line, "What file?", five modified cards, Confirm fixed at the bottom', () => {
    const src = read('src/app/attendance/upload/page.tsx')
    assert.ok(src.includes('Step {current} of {STEP_LABELS.length}'))
    assert.ok(src.includes('<summary>What file?</summary>'))
    assert.ok(src.includes('const PHONE_MODIFIED_PREVIEW = 5'))
    assert.ok(src.includes('Show all {preview.modifiedRecords.length}'))
    const css = phoneRules(read('src/app/attendance/upload/upload.module.css'))
    assert.match(css, /\.confirmBar \{[^}]*position: fixed;/)
    assert.match(css, /\.steps \{ display: none; \}/)
  })

  test('employee directory: a two-line card that opens the employee, Edit a 44px pencil, warning one line', () => {
    const src = read('src/app/attendance/employees/page.tsx')
    assert.ok(src.includes('className={styles.cardLink} aria-label={`View ${emp.full_name}`}'))
    assert.ok(src.includes('className={styles.cardEdit} onClick={() => setEditEmp(emp)}'))
    assert.ok(src.includes('<details className={styles.unlinkedFold}>'))
    const css = phoneRules(read('src/app/attendance/employees/employees.module.css'))
    assert.match(css, /\.total \{ display: none; \}/)
    assert.match(css, /\.cardEdit \{[^}]*width: 44px; height: 44px;/)
  })

  test('the issues queue is one row on a phone wherever it appears; the log note folds', () => {
    const src = read('src/components/objections/ObjectionQueue.tsx')
    assert.ok(src.includes('className={styles.phoneToggle}') && src.includes('aria-expanded={phoneOpen}'))
    assert.ok(src.includes('` · ${pending.length} awaiting`'))
    const css = phoneRules(read('src/components/objections/objectionQueue.module.css'))
    assert.match(css, /\.head \{ display: none !important; \}/)
    assert.match(css, /\.folded \{ display: none !important; \}/)
    const log = read('src/app/attendance/correction-log/page.tsx')
    assert.ok(log.includes('ap4-log-month') && log.includes('<details className="ap4-phone-fold">'))
  })

  test('requests: the card opens the review, reason one line, Try again 44px', () => {
    const src = read('src/components/attendanceRequests/RequestQueue.tsx')
    assert.ok(src.includes('className={styles.cardOpen}'))
    assert.equal(src.includes('minHeight: 36'), false)
    const css = phoneRules(read('src/components/attendanceRequests/attendanceRequests.module.css'))
    assert.match(css, /\.retryBtn \{ min-height: 44px; \}/)
    assert.match(css, /\.shiftLabel \{ display: none; \}/)
    assert.match(css, /\.cardOpen \{[^}]*position: absolute; inset: 0;/)
  })

  test('sync, today and the monthly review: notes fold, links 44px, totals as chips', () => {
    const minop = phoneRules(read('src/app/attendance/minop/sync.module.css'))
    assert.match(minop, /\.tech > summary \{ min-height: 44px;/)
    assert.match(minop, /\.legend \{ order: 1; \}/)
    assert.ok(read('src/app/attendance/minop/page.tsx').includes("needsAttention(d) ? '' : ` ${styles.calm}`"))
    const today = phoneRules(read('src/app/attendance/today/today.module.css'))
    assert.match(today, /\.stripLink, \.backToday \{ min-height: 44px; display: inline-flex;/)
    assert.ok(read('src/app/attendance/today/page.tsx').includes('<summary>What to check</summary>'))
    const review = read('src/app/attendance/monthly-review/page.tsx')
    assert.ok(review.includes('<ul className="ap4-chips" aria-label="Month totals">'))
    assert.ok(review.includes('ap4-card-link'))
    assert.ok(review.includes('<summary>How attendance is counted</summary>'))
    const g = read('src/app/globals.css')
    assert.ok(g.includes('PHONE PHASE 4 — ATTENDANCE & PAYROLL'))
    assert.match(g, /\.ap4-decide \{ min-height: 44px !important;/)
    assert.match(g, /\.ap4-clear \{ min-height: 40px !important;/)
  })
})

describe('Phase 4: payroll pages', () => {
  test('Payroll Runs: totals one line, the card opens the results, secondary actions in ⋯', () => {
    const src = read('src/app/payroll/page.tsx')
    assert.ok(src.includes('<PayrollRowPhoneMenu {...rowProps(p)}'))
    assert.ok(src.includes('<PayrollRowPhonePrimary {...rowProps(p)} />'))
    assert.ok(src.includes('<Link href={`/payroll/results/${p.id}`} className={`${ui.strong} ${styles.runLink}`}>'))
    const css = phoneRules(read('src/app/payroll/page.module.css'))
    assert.match(css, /\.dismiss \{ min-width: 44px; min-height: 44px;/)
    assert.match(read('src/app/payroll/PayrollRowActions.tsx'), /\.boe-payroll-attention \{ width: 44px; height: 44px; \}/)
  })

  test('Payroll Rules: one-line warning, save bar only when there is something to say, history folded', () => {
    const src = read('src/app/payroll/settings/page.tsx')
    assert.ok(src.includes('<summary>Changes apply to new payroll only</summary>'))
    assert.ok(src.includes('<summary>How the bands work</summary>'))
    assert.ok(src.includes('aria-controls="settings-history"'))
    const css = phoneRules(read('src/app/payroll/settings/settings.module.css'))
    assert.match(css, /\.saveBarIdle \{ display: none; \}/)
    assert.match(css, /\.saveBarDirty \{[^}]*position: fixed;/)
  })

  test('a payroll run: no back row, one run-state row, totals first, the card opens the payslip', () => {
    const src = read('src/app/payroll/results/[periodId]/page.tsx')
    assert.ok(src.includes('{reviewedCount}/{totalCount} reviewed'))
    assert.ok(src.indexOf('<ul className="ap4-chips" aria-label="Totals">') < src.indexOf('<ul className={ui.cards} aria-label="Employee results">'))
    assert.ok(src.includes('className={`${ui.strong} ${styles.resultLink}`}'))
    const css = phoneRules(read('src/app/payroll/results/[periodId]/results.module.css'))
    assert.match(css, /\.backRow \{ display: none; \}/)
    assert.match(css, /\.runState \{ flex-wrap: nowrap;/)
  })

  test('preview detail uses the payslip phone rules; no 11px labels left', () => {
    const src = read('src/app/payroll/monthly-review/[userId]/page.tsx')
    assert.ok(src.includes('<div className={`payroll-detail-page ${phone.detail}`}>'))
    assert.ok(src.includes('<span className={ui.phoneOnly}>Preview</span>'))
    for (const f of ['src/app/payroll/monthly-review/preview.module.css', 'src/app/my-payroll/myPayroll.module.css']) {
      // The ▾ glyph after a summary is not text to read.
      assert.equal(/font-size: 11px/.test(phoneRules(read(f)).replace(/summary::after \{[^}]*\}/g, '')), false, f)
    }
  })
})
