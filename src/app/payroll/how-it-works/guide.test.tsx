/**
 * How Payroll Works — the redesigned guide.
 *
 * What these pin, and why each is worth a test:
 *
 *   1. ACCURACY. Every band, rate and threshold the page states is asserted
 *      against the constant the ENGINE calculates with. A guide that describes a
 *      rule the engine does not apply is worse than no guide — an employee who
 *      checks their payslip against it finds the two disagreeing and has no way
 *      to know which is wrong. This is the section that would have caught the
 *      stale "Half Day = 3.75–5 hours" copy that shipped for months after
 *      classification.ts merged the band down to the presence floor.
 *
 *   2. THE JOURNEY IS A CHAIN. Each step's result is the next step's input. If
 *      that stops being true the page is a pile of cards again.
 *
 *   3. ROLE SAFETY. The employee list must contain no management route. Hiding
 *      a link is not authorisation — the guards are what refuse — but offering
 *      an employee a link that bounces is still a defect.
 *
 *   4. NOTHING STRUCTURAL MOVED. No engine, API, schema or migration file is
 *      touched by a presentation change, and the page still reads no employee
 *      record for anybody.
 *
 * Run:
 *   npx tsx --test src/app/payroll/how-it-works/guide.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PRESENCE_THRESHOLD_HOURS,
  SCHEDULED_IN_MINUTES,
  GRACE_END_MINUTES,
  SCHEDULED_OUT_MINUTES,
  ROUNDING_BLOCK_MINUTES,
  ROUNDING_BLOCK_HOURS,
} from '@/lib/attendance/scheduleRules'
import {
  PER_DAY_DIVISOR,
  PER_HOUR_DIVISOR,
  MISSING_PUNCH_HOURS,
  PAID_LEAVE_TIERS,
  RULE_CARDS,
  EXAMPLE_SETTLEMENT,
} from '@/lib/payroll/rules'
import { payableDayValue } from '@/lib/payroll/resultTabs'
import { minutesToClock } from '@/lib/payroll/settings'
import { classifyAttendanceDay } from '@/lib/attendance/classification'
import {
  ATTENDANCE_STATES,
  EMPLOYEE_ACTIONS,
  ADMIN_ACTIONS,
  FORMULA_STRIP,
  ISSUE_FLOW,
  JOURNEY,
  KEY_NUMBERS,
  PARAMETERS,
  SECTIONS,
  guideActionsFor,
} from './guideContent'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const PAGE    = read('src/app/payroll/how-it-works/page.tsx')
const CONTENT = read('src/app/payroll/how-it-works/guideContent.ts')
const VISUALS = read('src/app/payroll/how-it-works/GuideVisuals.tsx')
const CSS     = read('src/app/globals.css')

/** Every string the page can show, so a claim can be searched for once. */
const ALL_COPY = [
  ...JOURNEY.flatMap(s => [s.title, s.summary, s.input, s.result, s.why ?? '']),
  ...ATTENDANCE_STATES.flatMap(s => [s.label, s.meaning, s.salaryEffect]),
  ...PARAMETERS.flatMap(p => [p.rule, p.condition, p.effect, p.adminCanChange]),
  ...KEY_NUMBERS.flatMap(n => [n.label, n.value, n.note ?? '']),
].join('\n')

// ─── 1. Accuracy against the engine ──────────────────────────────────────────

describe('every rule the guide states matches the engine', () => {
  test('the half-day band is the one the classifier actually produces', () => {
    // The defect this exists for. classification.ts merged `short_present` into
    // `half_day`, so the band runs from the presence floor to the short-hours
    // threshold — NOT from threshold_half_day_hours, which no longer decides
    // anything. Assert against the classifier's behaviour, not its constants.
    const half = ATTENDANCE_STATES.find(s => s.classification === 'half_day')
    assert.ok(half)
    assert.ok(
      half.meaning.includes(String(PRESENCE_THRESHOLD_HOURS.short_present)) &&
      half.meaning.includes(String(PRESENCE_THRESHOLD_HOURS.present_with_shortfall)),
      `half day band must read ${PRESENCE_THRESHOLD_HOURS.short_present}–${PRESENCE_THRESHOLD_HOURS.present_with_shortfall}, got: ${half.meaning}`,
    )
  })

  test('…and the classifier agrees, at both ends of that band', () => {
    // A day is built from punch times so the assertion runs through the real
    // classifier rather than restating its constants. 10:00 start, no lunch
    // overlap for the short days.
    const day = (fromMinutes: number, hours: number) => {
      const base = Date.UTC(2026, 6, 1, 0, 0) - 330 * 60 * 1000
      const start = new Date(base + fromMinutes * 60_000).toISOString()
      const end   = new Date(base + (fromMinutes + hours * 60) * 60_000).toISOString()
      return classifyAttendanceDay({ check_in_at: start, check_out_at: end, direction_source: 'confirmed' })
    }
    // Just above the presence floor → a half day, not the retired short-present.
    assert.equal(day(14 * 60, PRESENCE_THRESHOLD_HOURS.short_present + 0.25).classification, 'half_day')
    // Just below it → an absence.
    assert.equal(day(14 * 60, PRESENCE_THRESHOLD_HOURS.short_present - 0.25).classification, 'full_absent')
    // The classifier can no longer emit short_present at all.
    for (let h = 0.25; h <= 12; h += 0.25) {
      assert.notEqual(day(14 * 60, h).classification, 'short_present', `${h}h produced short_present`)
    }
  })

  test('the retired classification is not offered as a current state', () => {
    assert.equal(
      ATTENDANCE_STATES.some(s => s.classification === 'short_present'), false,
      'Short Present is no longer produced and must not be listed as a current day state',
    )
    assert.equal(
      RULE_CARDS.some(c => c.key === 'short_present'), false,
      'the Short Present rule card describes a rule the engine no longer applies',
    )
  })

  test('payable-day values come from the engine, not from prose', () => {
    for (const s of ATTENDANCE_STATES) {
      assert.equal(s.payable, payableDayValue(s.classification), s.classification)
    }
    // And the words match the numbers, so the table survives greyscale.
    const byClass = Object.fromEntries(ATTENDANCE_STATES.map(s => [s.classification, s]))
    assert.equal(byClass['full_present']!.payableLabel, '1 day')
    assert.equal(byClass['half_day']!.payableLabel, '½ day')
    assert.equal(byClass['full_absent']!.payableLabel, 'Not counted')
  })

  test('the rates are the divisors the engine divides by', () => {
    assert.ok(ALL_COPY.includes(`÷ ${PER_DAY_DIVISOR}`), 'per-day divisor missing')
    assert.ok(ALL_COPY.includes(`÷ ${PER_HOUR_DIVISOR}`), 'per-hour divisor missing')
  })

  test('the office clock is the scheduled one', () => {
    for (const minutes of [SCHEDULED_IN_MINUTES, GRACE_END_MINUTES, SCHEDULED_OUT_MINUTES]) {
      assert.ok(ALL_COPY.includes(minutesToClock(minutes)), `${minutesToClock(minutes)} missing`)
    }
  })

  test('lateness is described in the block the engine rounds to', () => {
    const late = PARAMETERS.find(p => p.rule === 'Late arrival')
    assert.ok(late)
    assert.ok(late.effect.includes(String(ROUNDING_BLOCK_MINUTES)), 'rounding block missing')
    assert.ok(late.effect.includes(String(ROUNDING_BLOCK_HOURS)), 'block cost missing')
    assert.ok(
      late.condition.includes(String(GRACE_END_MINUTES - SCHEDULED_IN_MINUTES)),
      'the free grace window is not stated',
    )
  })

  test('a missing punch costs what the engine charges', () => {
    assert.ok(ALL_COPY.includes(`${MISSING_PUNCH_HOURS} hours`), 'missing-punch hours missing')
    const state = ATTENDANCE_STATES.find(s => s.classification === 'missing_punch')
    assert.ok(state?.salaryEffect.includes('still counts as present'),
      'the day must still be described as present')
  })

  test('the paid-leave bands are the bands in the settings defaults', () => {
    for (const tier of PAID_LEAVE_TIERS.filter(t => t.leave > 0)) {
      assert.ok(ALL_COPY.includes(String(tier.min_days_present)), `band ${tier.min_days_present} missing`)
    }
  })

  test('no number in the content module is typed rather than imported', () => {
    // A literal band or rate here is exactly how the old copy drifted. Times,
    // thresholds and divisors must all arrive as identifiers.
    // Same list rulesSource.test.ts holds page.tsx to, extended to the module
    // the derivation actually moved into. A value an employee could check the
    // arithmetic against must never appear here as a bare number.
    for (const literal of [
      '÷ 26', '8.5', '10:00 AM', '10:15', '6:30 PM', '18:30',
      '7.5 effective', '2–5 effective',
    ]) {
      assert.equal(CONTENT.includes(literal), false, `hard-coded value in guideContent: ${literal}`)
    }
    // …and the divisors arrive as identifiers.
    assert.match(CONTENT, /PER_DAY_DIVISOR/)
    assert.match(CONTENT, /PER_HOUR_DIVISOR/)
    assert.match(CONTENT, /PRESENCE_THRESHOLD_HOURS/)
  })

  test('the guide never claims a flag is automatically a deduction', () => {
    const waivable = PARAMETERS.filter(p =>
      ['Late arrival', 'Early departure', 'Missing punch'].includes(p.rule))
    assert.equal(waivable.length, 3)
    for (const p of waivable) {
      assert.match(p.adminCanChange, /waived/i, `${p.rule} must say review can waive it`)
    }
    for (const rule of ['Half day', 'Absence']) {
      const row = PARAMETERS.find(p => p.rule === rule)
      assert.match(row!.adminCanChange, /restated/i, `${rule} must say the day can be restated`)
    }
  })
})

// ─── 2. The journey is a chain ───────────────────────────────────────────────

describe('the calculation journey', () => {
  test('runs in the documented order, attendance first and the employee last', () => {
    assert.deepEqual(
      JOURNEY.map(s => s.id),
      ['recorded', 'reviewed', 'payable-days', 'rates', 'deductions', 'paid-leave',
       'after-attendance', 'payable'],
    )
  })

  test('every step declares what it uses and what it produces', () => {
    for (const step of JOURNEY) {
      assert.ok(step.title.length > 0 && step.title.length < 60, `title too long: ${step.title}`)
      assert.ok(step.input.length > 0,  `${step.id} has no input`)
      assert.ok(step.result.length > 0, `${step.id} has no result`)
      // One sentence, not a paragraph. The whole point of the redesign.
      assert.ok(step.summary.length < 260, `${step.id} summary reads as a paragraph`)
    }
  })

  test('the titles alone tell the story', () => {
    // Attendance in, salary out — readable from the eight headings with nothing else.
    const titles = JOURNEY.map(s => s.title.toLowerCase()).join(' | ')
    assert.match(titles, /attendance is recorded/)
    assert.match(titles, /payable days/)
    assert.match(titles, /deductions/)
    assert.match(titles, /salary payable/)
  })

  test('the formula strip uses the payslip’s own words, in order', () => {
    assert.deepEqual(
      FORMULA_STRIP.map(t => t.label),
      ['Gross Salary', 'Attendance Deductions', 'Net Adjustments', 'Salary Payable'],
    )
    assert.deepEqual(FORMULA_STRIP.map(t => t.op), ['', '−', '+', '='])
    // Each term is a real payslip label, so the strip teaches no private vocabulary.
    for (const term of FORMULA_STRIP) {
      assert.ok(PAGE.includes('FORMULA_STRIP'), 'the page must render the strip')
      assert.ok(term.note.length > 0, `${term.label} needs a plain-language note`)
    }
  })

  test('the worked example is arithmetically correct', () => {
    const e = EXAMPLE_SETTLEMENT
    assert.equal(e.salary_after_attendance, e.gross_salary - e.attendance_deductions)
    assert.equal(e.other_adjustments, e.other_addition + e.other_deduction)
    assert.equal(e.net_adjustments, e.carry_forward + e.other_adjustments)
    assert.equal(e.salary_payable, e.salary_after_attendance + e.net_adjustments)
    assert.equal(e.closing_balance, e.salary_payable - e.amount_paid)
  })

  test('the example is labelled as an example, never as the reader’s salary', () => {
    assert.match(PAGE, /These are not your figures/)
    assert.match(VISUALS, /not a real week/)
  })
})

// ─── 3. Role safety ──────────────────────────────────────────────────────────

describe('role handling', () => {
  test('an employee is offered only self-service destinations', () => {
    assert.deepEqual(
      EMPLOYEE_ACTIONS.map(a => a.href),
      ['/my-attendance', '/my-payroll', '/my-issues'],
    )
    for (const action of EMPLOYEE_ACTIONS) {
      assert.equal(action.href.startsWith('/attendance'), false, action.href)
      assert.equal(action.href.startsWith('/payroll'), false, action.href)
    }
  })

  test('admin destinations are offered only to admins', () => {
    assert.equal(guideActionsFor(false), EMPLOYEE_ACTIONS)
    assert.equal(guideActionsFor(true), ADMIN_ACTIONS)
    // …and the page asks the question by role rather than rendering both.
    assert.match(PAGE, /guideActionsFor\(!!isAdmin\)/)
  })

  test('every destination the guide offers is a route that exists', () => {
    for (const action of [...EMPLOYEE_ACTIONS, ...ADMIN_ACTIONS]) {
      const page = join(ROOT, 'src', 'app', ...action.href.split('/').filter(Boolean), 'page.tsx')
      assert.ok(existsSync(page), `${action.href} has no page.tsx`)
    }
  })

  test('the page still carries no employee data', () => {
    for (const table of [
      'payroll_results', 'payroll_settlements', 'payroll_deduction_lines',
      'payroll_pending_adjustments', 'attendance_records', 'payroll_settings',
    ]) {
      assert.equal(PAGE.includes(table), false, `the guide queries ${table}`)
    }
    // The only row it reads is the caller's own profile, for the layout header.
    assert.match(PAGE, /\.eq\('id', session\.user\.id\)/)
    for (const route of ['/api/payroll/results', '/api/payroll/my-result', '/api/payroll/periods']) {
      assert.equal(PAGE.includes(route), false, `the guide calls ${route}`)
    }
  })
})

// ─── 4. Structure, layout and accessibility ──────────────────────────────────

describe('the page structure', () => {
  test('renders through the combined Attendance & Payroll shell, once', () => {
    assert.match(PAGE, /import \{ AttendancePayrollLayout \}/)
    assert.equal((PAGE.match(/<AttendancePayrollLayout/g) ?? []).length, 1,
      'exactly one shell — a second would mean two sidebars and two headers')
    // The shell owns the header, sidebar and notification bell; the page must
    // not grow its own.
    for (const forbidden of ['boe-sidebar', 'boe-page-header', 'IssueNotificationBell']) {
      assert.equal(PAGE.includes(forbidden), false, `the page reimplements ${forbidden}`)
    }
  })

  test('every required section is present and jump-linkable', () => {
    for (const section of SECTIONS) {
      assert.ok(PAGE.includes(`id="${section.id}"`), `no anchor for ${section.id}`)
    }
    assert.deepEqual(
      SECTIONS.map(s => s.id),
      ['journey', 'example', 'states', 'parameters', 'issues', 'reference'],
    )
  })

  test('the desktop layout is two columns and the rail is not decorative', () => {
    assert.match(CSS, /\.payroll-guide-layout/)
    assert.match(CSS, /minmax\(0, 1\.95fr\) minmax\(250px, 1fr\)/,
      'the main column must take roughly two thirds')
    // The rail carries real content, not filler.
    assert.ok(KEY_NUMBERS.length >= 6, 'the rail needs the parameters that move a salary')
    assert.ok(SECTIONS.length >= 5, 'the rail needs a jump list')
    assert.match(PAGE, /<GuideRail/)
  })

  test('nothing is sticky, so nothing can clip inside the shell', () => {
    // The shell's own page header is already sticky. A rail taller than the
    // remaining viewport would stick with its bottom unreachable.
    const guideCss = CSS.slice(CSS.indexOf('.payroll-guide-sr-only'))
    assert.equal(/position:\s*sticky/.test(guideCss), false, 'the guide introduced sticky positioning')
  })

  test('wide tables scroll inside their own box, never the page', () => {
    assert.match(CSS, /\.payroll-guide-scroll\s*\{[^}]*overflow-x:\s*auto/)
    assert.equal((PAGE.match(/payroll-guide-table/g) ?? []).length, 2,
      'both reference tables must use the scrollable table style')
    assert.equal((PAGE.match(/payroll-guide-scroll/g) ?? []).length, 2)
  })

  test('the layout collapses to one reading sequence on mobile', () => {
    // The grid is single-column by default and only becomes two at 1080px, so
    // the rail falls into the flow after the journey it summarises.
    const layout = CSS.slice(CSS.indexOf('.payroll-guide-layout'))
    assert.match(layout, /grid-template-columns:\s*1fr/)
    assert.match(layout, /@media \(min-width: 1080px\)/)
  })
})

describe('accessibility', () => {
  test('the heading outline starts at h1 and does not skip', () => {
    assert.match(PAGE, /<h1 className="payroll-guide-sr-only">/)
    assert.ok(PAGE.includes('<h2'), 'sections must be h2')
    assert.ok(PAGE.includes('<h3'), 'sub-sections must be h3')
    assert.equal(PAGE.includes('<h5'), false, 'a level was skipped')
  })

  test('day states do not rely on colour alone', () => {
    // Each row carries a distinct SILHOUETTE and states its value in words.
    for (const tone of ['good', 'half', 'caution', 'neutral']) {
      assert.ok(VISUALS.includes(`tone === '${tone}'`), `no distinct glyph for ${tone}`)
    }
    for (const s of ATTENDANCE_STATES) {
      assert.ok(s.payableLabel.length > 0, `${s.classification} has no textual value`)
    }
  })

  test('decorative graphics are hidden and informative ones are labelled', () => {
    assert.ok((VISUALS.match(/aria-hidden="true"/g) ?? []).length >= 2)
    assert.ok((VISUALS.match(/aria-label=/g) ?? []).length >= 2,
      'the funnel and the leave diagram carry information and must be labelled')
    assert.match(PAGE, /className="payroll-guide-sr-only"/)
  })

  test('links and jump targets have a visible focus state', () => {
    assert.match(CSS, /\.payroll-guide-link:focus-visible/)
    assert.match(CSS, /\.payroll-guide-jump:focus-visible/)
    assert.match(CSS, /outline:\s*2px solid/)
  })

  test('no animation was introduced', () => {
    for (const src of [PAGE, VISUALS]) {
      assert.equal(/animation:/.test(src), false, 'the guide added motion')
      assert.equal(/transition:/.test(src), false, 'the guide added motion')
    }
  })

  test('emoji are not used as the icon system', () => {
    assert.match(PAGE, /from 'lucide-react'/)
    for (const src of [PAGE, VISUALS, CONTENT]) {
      assert.equal(/\p{Extended_Pictographic}/u.test(src), false, 'emoji used as an icon')
    }
  })
})

// ─── 5. The issue loop ───────────────────────────────────────────────────────

describe('corrections and issues', () => {
  test('the loop runs upload → review → generate → check → raise → review → outcome → re-raise', () => {
    assert.equal(ISSUE_FLOW.length, 8)
    assert.deepEqual(ISSUE_FLOW.map(s => s.actor),
      ['admin', 'admin', 'admin', 'you', 'you', 'admin', 'you', 'you'])
    // The step employees do not know they have. canRaiseIssue in
    // src/lib/objections.ts blocks only while an issue is still OPEN.
    assert.match(ISSUE_FLOW[7]!.body, /again once it has been answered/)
  })

  test('raising an issue is not described as changing anything by itself', () => {
    const raise = ISSUE_FLOW.find(s => s.title.includes('raise an issue'))
    assert.match(raise!.body, /does not change your salary by itself/)
  })
})

// ─── 6. Nothing structural moved ─────────────────────────────────────────────

describe('the guide is presentation only', () => {
  // These were a `git diff --name-only HEAD` check, which asserted that the
  // WORKING TREE contained nothing but presentation changes. That was true of
  // the commit it was written for and false of every commit after it: the next
  // legitimate edit to settings.ts failed a payroll-guide test, which tells the
  // author nothing useful and trains people to ignore red.
  //
  // A test that runs forever must assert a property that holds forever. These
  // do: the guide's own files reach for nothing that could change a payslip,
  // and the constants it renders are the documented ones.

  const GUIDE_FILES = [PAGE, CONTENT, VISUALS]

  test('the guide reaches for no API, migration or schema', () => {
    for (const src of GUIDE_FILES) {
      assert.equal(/from '@\/app\/api/.test(src), false, 'the guide imports an API route')
      assert.equal(src.includes('supabase/migrations'), false, 'the guide references a migration')
      assert.equal(/\.(insert|update|upsert|delete)\(/.test(src), false, 'the guide writes to a table')
    }
  })

  test('the guide imports rule constants, never the engine that applies them', () => {
    // Reading the numbers is the whole design (ADR-0005). Importing the engine
    // or the settlement layer would let a presentation change alter behaviour.
    for (const src of GUIDE_FILES) {
      assert.equal(src.includes("payroll/engine"), false, 'the guide imports the engine')
      assert.equal(src.includes("payroll/settingsStore"), false, 'the guide imports the settings store')
    }
    assert.match(CONTENT, /from '@\/lib\/payroll\/rules'/)
  })

  test('the calculation constants are unchanged', () => {
    // rules.ts prose was corrected; the numbers it exports were not.
    assert.equal(PER_DAY_DIVISOR, 26)
    assert.equal(PER_HOUR_DIVISOR, 8.5)
    assert.equal(MISSING_PUNCH_HOURS, 2)
    assert.equal(PRESENCE_THRESHOLD_HOURS.full_present, 7.5)
    assert.equal(PRESENCE_THRESHOLD_HOURS.present_with_shortfall, 5)
    assert.equal(PRESENCE_THRESHOLD_HOURS.short_present, 2)
    assert.deepEqual(PAID_LEAVE_TIERS.map(t => [t.min_days_present, t.leave]),
      [[16, 1], [11, 0.5], [0, 0]])
  })
})
