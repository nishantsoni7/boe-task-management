/**
 * The Review Workflow report and leaderboard — the pure rules and what the screens
 * and the migration SAY. The figures themselves are EXECUTED against PostgreSQL by
 * supabase/tests/custom_review_reporting_assertions.sql (boundaries, ties, zero rows,
 * reconciliation); this pins the parts a browser can get wrong.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/reviewReport.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIRST_PLACE_FOOTNOTE,
  FOCUS_LABELS,
  POINTS_PER_CREDIT,
  axisMax,
  barSegments,
  contributors,
  firstPlaceMessage,
  monthChoices,
  parseLeaderCard,
  parseLeaderboard,
  parseReportList,
  parseReviewReport,
  reconciliationProblems,
  reviewsNeededForFirst,
  shortDay,
  type EmployeeRow,
  type ReviewReport,
} from './reviewReport'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20270225000000_customer_review_reporting_and_leaderboard.sql')
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const REPORTS = read('src/app/customer-reviews/ReportsScreen.tsx')
const BOARD = read('src/components/customerReviews/ReviewLeaderboardScreen.tsx')
const CARD = read('src/components/customerReviews/ReviewLeaderCard.tsx')
const CHARTS = read('src/components/customerReviews/ReviewCharts.tsx')
const NAV = read('src/components/layout/CustomerReviewsLayout.tsx')
const DASHBOARD = read('src/app/dashboard/page.tsx')

function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start !== -1, `${name} is not defined`)
  const body = code.indexOf('$$', start)
  const end = code.indexOf('$$;', body + 2)
  return code.slice(start, end)
}

const emp = (over: Partial<EmployeeRow> & { name: string; submitted: number }): EmployeeRow => ({
  employee_id: over.name, text: over.submitted, image: 0, eligible: 0, eligible_text: 0, eligible_image: 0, credits: 0, points: 0, ...over,
})

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  month: '2027-02-01', current_month: '2027-02-01', points_per_credit: 10,
  summary: {
    submitted: 5, text: 3, image: 2, pending: 1, approved: 3, rejected: 1,
    eligible: 3, eligible_text: 2, eligible_image: 1, credits: 3.5, points: 35, duplicates_open: 0,
  },
  daily: [{ day: '2027-02-01', text: 2, image: 1 }, { day: '2027-02-02', text: 1, image: 1 }],
  history: [{ month: '2027-01-01', text: 0, image: 0, submitted: 0, eligible: 0, credits: 0 }, { month: '2027-02-01', text: 3, image: 2, submitted: 5, eligible: 3, credits: 3.5 }],
  categories: [
    { type: 'text', pending: 1, approved: 2, rejected: 0, submitted: 3, eligible: 2, credits: 2 },
    { type: 'image', pending: 0, approved: 1, rejected: 1, submitted: 2, eligible: 1, credits: 1.5 },
  ],
  employees: [
    emp({ name: 'A', submitted: 3, text: 2, image: 1, eligible: 2, eligible_text: 1, eligible_image: 1, credits: 2.5, points: 25 }),
    emp({ name: 'B', submitted: 2, text: 1, image: 1, eligible: 1, eligible_text: 1, credits: 1, points: 10 }),
    emp({ name: 'Zero', submitted: 0, text: 0 }),
  ],
  ...over,
})

describe('the points rule', () => {
  test('points = credits x 10, and the multiplier is the database\'s', () => {
    assert.equal(POINTS_PER_CREDIT, 10)
    assert.match(code, /create or replace function public\.customer_review_points_per_credit\(\)\s+returns numeric\s+language sql\s+immutable\s+as \$\$ select 10::numeric \$\$;/)
    assert.match(code, /coalesce\(sum\(credits\), 0\) \* v_ppc/)
  })
  test('points are per month and never carried: the rows are one IST month', () => {
    assert.match(fn('customer_review_report_rows'), /s\.submitted_at >= \(p_from::timestamp at time zone 'Asia\/Kolkata'\)/)
    assert.match(fn('customer_review_report_rows'), /s\.submitted_at <  \(p_to::timestamp   at time zone 'Asia\/Kolkata'\)/)
  })
})

describe('reading and reconciling the report', () => {
  test('a well-formed report parses and reconciles', () => {
    const parsed = parseReviewReport(JSON.parse(JSON.stringify(report())))
    assert.ok(parsed)
    assert.deepEqual(reconciliationProblems(parsed!), [])
  })
  test('anything else is null — never a half-drawn dashboard', () => {
    for (const bad of [null, 'x', 1, {}, { month: '2027-02-01' }, { month: '2027-02-01', summary: {}, daily: 'no', employees: [] }]) {
      assert.equal(parseReviewReport(bad), null)
    }
  })
  test('numbers arriving as strings (numeric columns) are read', () => {
    const raw = JSON.parse(JSON.stringify(report()))
    raw.summary.credits = '3.50'; raw.summary.points = '35.00'; raw.employees[0].credits = '2.50'; raw.employees[0].points = '25.00'
    raw.employees[1].credits = '1.00'; raw.employees[1].points = '10.00'
    const parsed = parseReviewReport(raw)!
    assert.equal(parsed.summary.credits, 3.5)
    assert.deepEqual(reconciliationProblems(parsed), [])
  })
  test('a report that contradicts itself is named, not drawn', () => {
    assert.match(reconciliationProblems(report({ summary: { ...report().summary, text: 4 } })).join(' '), /text \+ image does not equal submitted/)
    assert.match(reconciliationProblems(report({ summary: { ...report().summary, eligible: 9, eligible_text: 9, eligible_image: 0 } })).join(' '), /eligible exceeds submitted/)
    assert.match(reconciliationProblems(report({ employees: report().employees.slice(0, 2).map(e => ({ ...e, submitted: e.submitted + 1 })) })).join(' '), /employee rows do not add up to submitted/)
    assert.match(reconciliationProblems(report({ daily: [{ day: '2027-02-01', text: 9, image: 9 }] })).join(' '), /daily bars/)
    assert.match(reconciliationProblems(report({ summary: { ...report().summary, points: 99 } })).join(' '), /points are not credits/)
    assert.match(reconciliationProblems(report({ history: [{ month: '2027-02-01', text: 0, image: 0, submitted: 0, eligible: 0, credits: 0 }] })).join(' '), /history/)
  })
})

describe('highest and lowest contributors, ties included', () => {
  test('every employee on the top count and on the bottom count is named', () => {
    const rows = [emp({ name: 'A', submitted: 5 }), emp({ name: 'B', submitted: 5 }), emp({ name: 'C', submitted: 2 }), emp({ name: 'Z1', submitted: 0 }), emp({ name: 'Z2', submitted: 0 })]
    const c = contributors(rows)
    assert.deepEqual(c.highest.map(r => r.name), ['A', 'B'])
    assert.deepEqual(c.lowest.map(r => r.name), ['Z1', 'Z2'])
    assert.equal(c.allTied, false)
  })
  test('zero-submission employees are the lowest, so the lowest activity is visible', () => {
    assert.deepEqual(contributors([emp({ name: 'A', submitted: 3 }), emp({ name: 'Z', submitted: 0 })]).lowest.map(r => r.name), ['Z'])
  })
  test('everyone on one count is "all tied", not a highest', () => {
    const c = contributors([emp({ name: 'A', submitted: 2 }), emp({ name: 'B', submitted: 2 })])
    assert.equal(c.allTied, true)
    assert.deepEqual(c.highest, [])
    assert.deepEqual(contributors([]), { highest: [], lowest: [], allTied: false })
  })
})

describe('the first-place target', () => {
  test('X = leader count - your count + 1', () => {
    assert.equal(reviewsNeededForFirst(4, 3), 2)
    assert.equal(reviewsNeededForFirst(4, 0), 5)
    assert.equal(reviewsNeededForFirst(1, 0), 2)
    assert.equal(reviewsNeededForFirst(4, 4), null)
    assert.equal(reviewsNeededForFirst(4, 5), null)
    // the same formula the database applies
    assert.match(fn('customer_review_leaderboard'), /v_need := v_leader - v_my_reviews \+ 1/)
  })
  test('the message: leading, joint, behind (singular and plural), nobody has a review yet', () => {
    assert.equal(firstPlaceMessage('leading', null), "You're leading")
    assert.equal(firstPlaceMessage('joint', null, 2), "You're joint first with 1 other")
    assert.equal(firstPlaceMessage('joint', null, 3), "You're joint first with 2 others")
    assert.equal(firstPlaceMessage('behind', 2), 'You need 2 more reviews to take first place')
    assert.equal(firstPlaceMessage('behind', 1), 'You need 1 more review to take first place')
    assert.equal(firstPlaceMessage('no_activity', 1), 'You need 1 more review to take first place')
    assert.match(firstPlaceMessage('not_taking_part', null), /not open to you/)
  })
  test('the target is labelled as additional ELIGIBLE reviews, not a guaranteed award', () => {
    assert.match(FIRST_PLACE_FOOTNOTE, /additional eligible reviews/)
    assert.match(FIRST_PLACE_FOOTNOTE, /not a guaranteed award/)
    assert.match(BOARD, /FIRST_PLACE_FOOTNOTE/)
    assert.match(CARD, /a target, not a guaranteed award/)
  })
  test('the database ranks equal counts equally and keeps the states apart', () => {
    const lb = fn('customer_review_leaderboard')
    assert.match(lb, /1 \+ \(select count\(\*\) from s o where o\.reviews > s\.reviews\)/)
    assert.match(lb, /'tied', \(select count\(\*\) from ranked x where x\.rank = t\.rank\) > 1/)
    assert.match(lb, /order by t\.reviews desc, t\.name, t\.employee_id/)
    for (const state of ['leading', 'joint', 'behind', 'no_activity', 'not_taking_part']) assert.match(lb, new RegExp(`'${state}'`))
  })
})

describe('parsing the leaderboard, the card and the list', () => {
  const board = {
    month: '2027-02-01', current_month: '2027-02-01', leader_reviews: 4, leaders: 1, state: 'behind', need: 2,
    me: { rank: 2, reviews: 3, credits: '3.00', points: '30.00' }, participants: 2,
    rows: [
      { rank: 1, employee_id: 'a', name: 'Asha', reviews: 4, credits: '4.50', points: '45.00', is_me: false, tied: false },
      { rank: 2, employee_id: 'b', name: 'Bina', reviews: 3, credits: '3.00', points: '30.00', is_me: true, tied: false },
    ],
  }
  test('a leaderboard reads, with numeric strings', () => {
    const b = parseLeaderboard(board)!
    assert.equal(b.rows[1].is_me, true)
    assert.equal(b.rows[0].credits, 4.5)
    assert.equal(b.me?.points, 30)
    assert.equal(b.need, 2)
  })
  test('an unknown state or shape is refused', () => {
    assert.equal(parseLeaderboard({ ...board, state: 'winning' }), null)
    assert.equal(parseLeaderboard({ ...board, rows: 'x' }), null)
    assert.equal(parseLeaderboard(null), null)
    assert.equal(parseLeaderCard({ month: '2027-02-01', state: 'nope' }), null)
  })
  test('the card carries the joint leaders and the same target', () => {
    const c = parseLeaderCard({ month: '2027-02-01', leader_reviews: 4, leaders: 2, leader_names: ['Asha', 'Chetan'], state: 'behind', need: 2, me: null })!
    assert.deepEqual(c.leader_names, ['Asha', 'Chetan'])
    assert.equal(c.need, 2)
    assert.equal(c.me, null)
  })
  test('a list page reads and defaults safely', () => {
    const l = parseReportList({ total: '30', limit: 25, offset: 0, rows: [{ id: 'x', submission_ref: 'CR-1', review_type: 'image', status: 'approved', eligible: true, credits: '1.50', points: '15.00' }] })!
    assert.equal(l.total, 30)
    assert.equal(l.rows[0].credits, 1.5)
    assert.equal(l.rows[0].review_type, 'image')
    assert.equal(parseReportList({ total: 1 }), null)
  })
})

describe('chart and month helpers', () => {
  test('axis maxima are friendly and never below 4', () => {
    assert.equal(axisMax(0), 4)
    assert.equal(axisMax(3), 4)
    assert.equal(axisMax(5), 5)
    assert.equal(axisMax(7), 10)
    assert.equal(axisMax(11), 20)
    assert.equal(axisMax(37), 40)
    assert.equal(axisMax(101), 200)
  })
  test('a bar\'s segments add up to its total height', () => {
    const { textH, imageH } = barSegments(3, 2, 10, 100)
    assert.equal(textH + imageH, 50)
    assert.deepEqual(barSegments(3, 2, 0, 100), { textH: 0, imageH: 0 })
  })
  test('month choices are the current month and the eleven before, newest first', () => {
    const m = monthChoices('2027-02-01')
    assert.equal(m.length, 12)
    assert.equal(m[0], '2027-02-01')
    assert.equal(m[2], '2026-12-01')
    assert.equal(m[11], '2026-03-01')
    assert.equal(shortDay('2027-02-03'), '3 Feb')
  })
  test('every focus has a label', () => {
    for (const f of ['all', 'text', 'image', 'eligible', 'duplicates'] as const) assert.ok(FOCUS_LABELS[f])
  })
})

describe('the database definitions the screens rely on', () => {
  test('the report is a verifier\'s, checked inside the function; the leaderboard needs only an active account', () => {
    for (const name of ['customer_review_report', 'customer_review_report_list']) {
      assert.match(fn(name), /resolve_permission\(v_uid, 'customer_review_requests', 'verify'\)/, name)
    }
    assert.doesNotMatch(fn('customer_review_leaderboard'), /resolve_permission\(v_uid, 'customer_review_requests', 'verify'\)/)
    assert.match(fn('customer_review_leaderboard'), /u\.is_active and coalesce\(u\.is_deleted, false\) = false/)
  })
  test('deleted reviews are out of every total; eligibility follows the ledger and the month', () => {
    const rows = fn('customer_review_report_rows')
    assert.match(rows, /where s\.deleted_at is null/)
    assert.match(rows, /rv\.transaction_type = 'reversal'/)
    assert.match(rows, /m\.status = 'lapsed'/)
    assert.match(rows, /\(s\.status = 'approved' or s\.reward_held\)/)
  })
  test('the internal functions are callable by no client role; the public ones by authenticated only', () => {
    assert.match(code, /revoke execute on function public\.customer_review_report_rows\(date, date, uuid, text, text\) from public, anon, authenticated, service_role;/)
    assert.match(code, /revoke execute on function public\.customer_review_month_standings\(date\) from public, anon, authenticated, service_role;/)
    for (const sig of ['customer_review_report(date, uuid, text, text)', 'customer_review_leaderboard(date)', 'customer_review_leader_card()']) {
      assert.ok(code.includes(`revoke execute on function public.${sig} from public, anon;`), sig)
      assert.ok(code.includes(`grant  execute on function public.${sig} to authenticated;`), sig)
    }
  })
  test('the list returns references and dates only — no text, name or proof', () => {
    const list = fn('customer_review_report_list')
    assert.doesNotMatch(list, /review_text|reviewer_name|proof_storage_path|remark/)
    assert.match(list, /least\(coalesce\(p_limit, 25\), 50\)/)
  })
  test('the report writes nothing', () => {
    assert.doesNotMatch(code, /\b(insert into|update public|delete from|alter table)\b/)
    assert.doesNotMatch(code, /post_boe_credit/)
  })
  test('one aggregate feeds the dashboard', () => {
    const report = fn('customer_review_report')
    for (const key of ['summary', 'daily', 'history', 'categories', 'employees']) assert.match(report, new RegExp(`'${key}'`))
    assert.match(report, /generate_series\(v_month, \(v_to - 1\), interval '1 day'\)/)
    assert.match(report, /generate_series\(v_hist_from, v_month, interval '1 month'\)/)
  })
})

describe('the screens', () => {
  test('the dashboard reads only server aggregates and pages — never a review row, text or proof', () => {
    assert.match(REPORTS, /rpc\('customer_review_report'/)
    assert.match(REPORTS, /rpc\('customer_review_report_list'/)
    assert.doesNotMatch(REPORTS, /\.from\('customer_review_custom_submissions'\)/)
    assert.doesNotMatch(REPORTS, /review_text|proof_storage_path|createSignedUrl/)
    assert.match(REPORTS, /REPORT_PAGE_SIZE/)
  })
  test('month defaults to the current one, previous months selectable; employee, type and status filters', () => {
    assert.match(REPORTS, /monthChoices\(current\)/)
    assert.match(REPORTS, /\(current\)/)
    for (const label of ['Employee', 'Type', 'Status', 'Month']) assert.ok(REPORTS.includes(`${label}\n`) || REPORTS.includes(`${label}\r\n`) || REPORTS.includes(`        ${label}`))
  })
  test('the four cards, the daily and monthly split, the breakdown and the comparison are all there', () => {
    for (const s of ['Total submitted', 'Text reviews', 'Image reviews', 'Possible duplicates awaiting a decision', 'Reward-eligible reviews', 'Monthly history', 'By type and status', 'Contributors']) {
      assert.ok(REPORTS.includes(s), s)
    }
    assert.match(REPORTS, /<StackedBarChart/)
    assert.equal((REPORTS.match(/<StackedBarChart/g) ?? []).length, 2)
  })
  test('a card and an employee row open the matching list', () => {
    assert.match(REPORTS, /onOpen\('all'\)/)
    assert.match(REPORTS, /onOpen\('text'\)/)
    assert.match(REPORTS, /onOpen\('image'\)/)
    assert.match(REPORTS, /onOpen\('duplicates'\)/)
    assert.match(REPORTS, /onOpen\('eligible'\)/)
    assert.match(REPORTS, /onOpen\('all', e\.employee_id, e\.name\)/)
    assert.match(REPORTS, /\/customer-reviews\/custom\?submission=/)
  })
  test('loading, empty, error and reconciliation states', () => {
    assert.match(REPORTS, /Loading the report/)
    assert.match(REPORTS, /No reviews were submitted in/)
    assert.match(REPORTS, /Try again/)
    assert.match(REPORTS, /reconciliationProblems\(report\)/)
    assert.match(REPORTS, /figures do not agree with each other, so it is not shown/)
  })
  test('submitted and eligible are shown apart, credits and points separately', () => {
    assert.match(REPORTS, /of \{s\.submitted\} submitted/)
    assert.match(REPORTS, /Review credits/)
    assert.match(REPORTS, /Review points \(credits × \$\{report\.points_per_credit\}\)/)
  })
  test('phone layout: cards and filters wrap, tables scroll inside their card, nothing widens the page', () => {
    assert.match(REPORTS, /repeat\(auto-fit, minmax\(min\(100%, 170px\), 1fr\)\)/)
    assert.ok((REPORTS.match(/overflowX: 'auto'/g) ?? []).length >= 2)
    assert.match(REPORTS, /minWidth: 0/)
    assert.match(CHARTS, /viewBox=/)
    assert.match(CHARTS, /width="100%"/)
    // the two wide tables become one card per row at 560px, so nothing is read by scrolling sideways
    const css = read('src/app/customer-reviews/reports.module.css')
    assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.wideOnly \{ display: none; \}[\s\S]*\.narrowList \{ display: flex; \}/)
    assert.equal((REPORTS.match(/className=\{styles\.narrowList\}/g) ?? []).length, 2)
    assert.equal((REPORTS.match(/className=\{styles\.wideOnly\}/g) ?? []).length, 2)
  })
  test('charts are accessible: role, title, description, legend and a table', () => {
    assert.match(CHARTS, /role="img"/)
    assert.match(CHARTS, /<title id=/)
    assert.match(CHARTS, /<desc id=/)
    assert.match(CHARTS, /Show as a table/)
    assert.match(CHARTS, /scope="col"/)
  })
  test('the report is a verifier\'s page: a non-verifier is redirected, the navigation lists it for verifiers only', () => {
    assert.match(REPORTS, /if \(!caps\.canVerify\) router\.replace\('\/customer-reviews'\)/)
    assert.match(NAV, /label: 'Reports',\s+path: '\/customer-reviews\/reports',[\s\S]*?verifierOnly: true/)
  })
  test('the leaderboard highlights you, keeps your rank visible, shows ties and both figures', () => {
    assert.match(BOARD, /aria-current=\{row\.is_me \? 'true' : undefined\}/)
    assert.match(BOARD, /meOutside/)
    assert.match(BOARD, /row\.tied &&/)
    assert.match(BOARD, /<th scope="col" style=\{th\}>Points<\/th>/)
    assert.match(BOARD, /<th scope="col" style=\{th\}>Credits<\/th>/)
    assert.match(BOARD, /Nobody has an eligible review in/)
    assert.match(BOARD, /rpc\('customer_review_leaderboard'/)
  })
  test('the leaderboard lives outside the module\'s permission guard, so every signed-in employee can open it', () => {
    assert.ok(readFileSync(join(process.cwd(), 'src/app/my-credits/leaderboard/page.tsx'), 'utf8').includes('ReviewLeaderboardScreen'))
    assert.doesNotMatch(BOARD, /hasPermission|canVerify|customer_review_requests/)
  })
  test('the dashboard card is small, self-contained, and links to the leaderboard', () => {
    assert.match(DASHBOARD, /<ReviewLeaderCard isMobile=\{isMobile\} \/>/)
    assert.equal((DASHBOARD.match(/<ReviewLeaderCard/g) ?? []).length, 1, 'one use')
    assert.match(DASHBOARD, /import \{ ReviewLeaderCard \} from '@\/components\/customerReviews\/ReviewLeaderCard'/)
    assert.match(CARD, /href="\/my-credits\/leaderboard"/)
    assert.match(CARD, /Review leaderboard unavailable right now/)
    assert.match(CARD, /rpc\('customer_review_leader_card'\)/)
    assert.ok(CARD.split('\n').length < 100, 'the card stays small')
  })
})
