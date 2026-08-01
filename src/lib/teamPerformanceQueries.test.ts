/**
 * Query-shape guard for the Team Performance endpoint.
 *
 * The endpoint's whole design premise is a fixed number of queries regardless
 * of team size. That is easy to destroy by accident: one `await client.from(…)`
 * slipped inside the per-employee loop turns a 7-query page into 7 + 3N, and
 * nothing in TypeScript or the unit tests would notice — it would just get
 * slower as the company grows.
 *
 * This inspects the route source rather than executing it, because there is no
 * HTTP/database harness in this project. It is a coarse check, but it catches
 * the specific regression that matters.
 *
 * Run:
 *   npx tsx --test src/lib/teamPerformanceQueries.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE = join(process.cwd(), 'src/app/api/performance-metrics/team/route.ts')
const source = readFileSync(ROUTE, 'utf8')

/** Body of the per-employee loop, where an N+1 would have to live. */
function memberLoopBody(): string {
  const start = source.indexOf('for (const user of userRows) {')
  assert.notEqual(start, -1, 'per-employee loop not found — has the route been restructured?')

  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) break }
  }
  return source.slice(from, i)
}

describe('team endpoint query shape', () => {
  test('issues a bounded number of queries', () => {
    const calls = source.match(/client\s*\.?\s*\n?\s*\.from\(/g) ?? []
    // 1 caller profile + 1 users + 8 bulk = 10.
    //
    // Two were added deliberately for System Adoption: the period's first-open
    // rows, and a single `order.limit(1)` for the earliest open ever recorded.
    // The second one exists so that a missing row can be distinguished from a row
    // that was never being collected — without it, a period in which nobody
    // opened the app would report "no data yet" and hide genuine total non-use.
    //
    // Both are in the same parallel round, so the added latency is zero. Raising
    // this ceiling should stay a deliberate decision, not a drive-by.
    assert.ok(calls.length <= 10, `expected at most 10 query sites, found ${calls.length}`)
  })

  test('no query is issued inside the per-employee loop', () => {
    const body = memberLoopBody()
    assert.equal(body.includes('.from('), false,
      'a database call appeared inside the per-employee loop — that is an N+1')
    assert.equal(/\bawait\b/.test(body), false,
      'an await appeared inside the per-employee loop — per-employee round trips are the thing this endpoint exists to avoid')
  })

  test('the bulk queries are scoped to the fetched user set', () => {
    // Every bulk read must be constrained by the user list, never a full scan.
    const bulk = source.slice(source.indexOf('Round 2'))
    const froms = bulk.match(/\.from\('(\w+)'\)/g) ?? []
    assert.ok(froms.length >= 5, 'expected the bulk round to still be present')
    const scoped = bulk.match(/\.in\('(assigned_to|actor_id|user_id|created_by)'/g) ?? []
    assert.ok(scoped.length >= 5, `expected each user-scoped read to use .in(), found ${scoped.length}`)
  })

  test('activity and EOD reads are bounded by the period span', () => {
    assert.ok(source.includes("gte('created_at', istDayStartUtc(spanStart))"),
      'activity log read is not bounded by the span start')
    assert.ok(source.includes("gte('log_date', spanStart)"),
      'EOD read is not bounded by the span start')
  })

  test('the page is not handed raw rows to score for itself', () => {
    // The response carries computed metrics. If it started shipping task or
    // activity rows, the client would inevitably start recomputing scores.
    const responseBody = source.slice(source.lastIndexOf('return NextResponse.json({'))
    for (const raw of ['activityLogs', 'activityByUser', 'completedTasks', 'createdTasks', 'eodLogs']) {
      assert.equal(responseBody.includes(raw), false,
        `raw ${raw} is being returned to the client — the page would start scoring for itself`)
    }
  })

  // ── Required case 28, second half: adoption added no per-employee round trip ──
  test('28. the adoption read is bulk, not per employee', () => {
    const body = memberLoopBody()
    assert.equal(body.includes('performance_app_opens'), false,
      'adoption is being read inside the per-employee loop — that is an N+1')
    // It is read once, for every tracked user, in the parallel round.
    assert.ok(source.includes("from('performance_app_opens')"),
      'the adoption read has disappeared')
    assert.ok(/performance_app_opens'\)[\s\S]{0,200}\.in\('user_id', userIds\)/.test(source),
      'the adoption read is not scoped to the tracked user set')
  })

  // ── Required case 1, structural half: exclusion happens before any measurement ─
  test('1b. eligibility is applied to the user list before the bulk round', () => {
    // `partitionByTracking(` appears in the import list first, so the call site is
    // the last occurrence. `Promise.all([` is the bulk round itself, rather than
    // the "Round 2" comment in the file header.
    const partitionAt = source.lastIndexOf('partitionByTracking(allActive)')
    const bulkAt      = source.indexOf('await Promise.all([')
    const loopAt      = source.indexOf('for (const user of userRows) {')

    assert.notEqual(partitionAt, -1, 'the eligibility partition has been removed')
    assert.ok(partitionAt < bulkAt,
      'eligibility must be applied before the bulk queries, so excluded users are never fetched')
    assert.ok(partitionAt < loopAt,
      'eligibility must be applied before the per-employee loop')

    // userIds — which scopes every bulk read — must come from the tracked list.
    assert.ok(source.includes('const userIds = userRows.map(u => u.id)'))
    assert.ok(source.includes('const { tracked: userRows, excluded } = partitionByTracking(allActive)'),
      'userRows must be the tracked subset, not the full active list')
  })

  test('the excluded list is admin-gated in the payload', () => {
    assert.ok(source.includes('canViewExcludedDetails(caller)'),
      'exclusion details are not gated on the caller role')
    assert.ok(source.includes('...(showExcludedDetails ? { excluded } : {})'),
      'the excluded array is not conditionally included')
  })

  // ── Required case 34 — authorization remains correct ──────────────────────────
  test('34. the endpoint still refuses non-management callers server-side', () => {
    assert.ok(source.includes('canViewTeamPerformance(caller)'),
      'the management gate has been removed')
    assert.ok(/if \(!canViewTeamPerformance\(caller\)\) \{\s*\n\s*return NextResponse\.json\(\{ error: 'Forbidden' \}, \{ status: 403 \}\)/.test(source),
      'the management gate no longer returns 403')
    // And it happens before the team list is read. (getCallerProfile's own
    // `from('users')` is the role lookup that feeds the gate, so the employee-list
    // select is the read that must come after it.)
    assert.ok(source.indexOf('canViewTeamPerformance(caller)') < source.indexOf("'id, full_name, team, position, joining_date"),
      'the authorization check must precede the team-list read')
  })

  // ── Required case 26, structural half: adoption failure is not fatal ──────────
  test('26b. a failed adoption read does not fail the request', () => {
    assert.ok(source.includes('adoptionAvailable'),
      'the adoption-availability flag has gone')

    // Adoption must be unwrapped in its OWN try/catch, separately from the five
    // score-bearing reads, so a failure sets eOpens instead of returning a 500.
    assert.match(source, /unwrapPagedRows\('app opens', appOpenRes\)/,
      'the adoption read is no longer unwrapped')
    assert.match(source, /catch \(e\) \{\s*\n\s*eOpens =/,
      'an adoption read failure must be captured into eOpens, not rethrown')

    // And the fatal block must not mention the adoption results at all.
    const fatalBlock = source.slice(
      source.indexOf('let activeTasks:'),
      source.indexOf('let appOpenRows'),
    )
    assert.ok(fatalBlock.length > 0, 'the fatal unwrap block has moved or gone')
    assert.equal(fatalBlock.includes('appOpenRes'), false,
      'an adoption read failure is being treated as fatal — the page would 500 over a supplementary metric')
    assert.equal(fatalBlock.includes('eFirstOpen'), false,
      'the first-ever-open lookup is being treated as fatal')
  })

  // ── Truncation must be rejected, not computed from ────────────────────────────
  test('7. every score-bearing paged read is unwrapped, so truncation cannot pass', () => {
    for (const label of ['tasks', 'completed tasks', 'activity log', 'EOD logs', 'created tasks']) {
      assert.ok(source.includes(`unwrapPagedRows('${label}',`),
        `the '${label}' read is not going through unwrapPagedRows — a capped or failed read could reach the calculations`)
    }
    assert.ok(source.includes('PagedReadError'),
      'the route no longer distinguishes a paged read failure')
    assert.ok(source.includes('row_cap_exceeded'),
      'the route no longer reports a capped read differently from a failed one')
  })

  test('no paged result has its rows read without going through the unwrapper', () => {
    // `.rows` on the union is a compile error until `ok` is narrowed, so this is a
    // belt-and-braces check that nobody added a cast to work around it.
    for (const v of ['activeRes', 'completedRes', 'activityRes', 'eodRes', 'createdRes', 'appOpenRes']) {
      assert.equal(source.includes(`${v}.rows`), false,
        `${v}.rows is read directly — use unwrapPagedRows so truncation is rejected`)
      assert.equal(source.includes(`${v}.error`), false,
        `${v}.error is read directly — the unwrapper owns that decision now`)
    }
  })
})

// ── Personal Performance route: the same defensive behaviour ──────────────────
describe('personal performance route', () => {
  const PERSONAL = join(process.cwd(), 'src/app/api/performance-metrics/route.ts')
  const personal = readFileSync(PERSONAL, 'utf8')

  test('6. every paged read is unwrapped, so a truncated read is refused', () => {
    // Before this change the route checked only `error` and would have scored a
    // window with missing days if a read had ever been capped.
    for (const label of ['open tasks', 'completed tasks', 'activity log', 'EOD logs']) {
      assert.ok(personal.includes(`unwrapPagedRows('${label}',`),
        `the '${label}' read is not going through unwrapPagedRows`)
    }
    for (const v of ['openRes', 'closedRes', 'activityRes', 'eodRes']) {
      assert.equal(personal.includes(`${v}.rows`), false, `${v}.rows is read directly`)
      assert.equal(personal.includes(`${v}.error`), false, `${v}.error is read directly`)
    }
  })

  test('a read failure becomes a 500 without leaking database detail', () => {
    // fetchWindow's contract is a Map; there is no partial Map that would be safe,
    // so it throws and GET converts that into a generic response.
    assert.match(personal, /catch \(e\) \{[\s\S]{0,200}?Failed to load performance data/,
      'the window fetch failure no longer produces a generic 500')
    const body = personal.match(/error: 'Failed to load performance data'/)
    assert.ok(body, 'the user-facing message has changed')
    // The detail belongs in the log, not the response.
    assert.match(personal, /console\.error\('performance-metrics window fetch failed:'/)
  })

  test('all four personal reads are paged in the first place', () => {
    const calls = personal.match(/fetchAllRows</g) ?? []
    assert.equal(calls.length, 4,
      'the personal route should page exactly its four windowed reads')
    // Each must carry a deterministic order for LIMIT/OFFSET paging to be sane.
    const ordered = personal.match(/\.order\('id'\)/g) ?? []
    assert.ok(ordered.length >= 4, 'every paged read needs a stable unique ordering')
  })
})

// ── Required case 23, structural half ────────────────────────────────────────
describe('app-open endpoint', () => {
  const OPEN_ROUTE = join(process.cwd(), 'src/app/api/performance/app-open/route.ts')
  const openSource = readFileSync(OPEN_ROUTE, 'utf8')

  test('23b. the user id comes from the token and never from the request body', () => {
    assert.ok(openSource.includes('client.auth.getUser(token)'),
      'the endpoint no longer resolves the user from the bearer token')
    assert.ok(openSource.includes('buildAppOpenRow(user.id'),
      'the row is not built from the token-resolved user')
    // The body is read only for `route`. A userId there would let View As — or any
    // caller — write adoption history for somebody else.
    assert.equal(/body\.(userId|user_id)/.test(openSource), false,
      'a user id is being read from the request body')
  })

  test('duplicate opens are absorbed by the database, not by application logic', () => {
    assert.ok(openSource.includes("onConflict: 'user_id,business_date'"))
    assert.ok(openSource.includes('ignoreDuplicates: true'))
  })

  test('every failure path still returns a non-error body', () => {
    assert.ok(openSource.includes('recorded: false'),
      'failures no longer degrade gracefully')
    assert.ok(openSource.includes('} catch'),
      'the handler is not wrapped against an unexpected failure (e.g. table absent)')
  })
})
