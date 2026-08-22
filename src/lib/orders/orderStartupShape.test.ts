/**
 * HOW MANY TIMES AN ORDER SCREEN WAITS BEFORE IT SHOWS ANYTHING.
 *
 * WHY THIS IS A TEST AND NOT A NOTE
 * ---------------------------------
 * Every Order Management screen opened the same way: get the session, then read
 * the profile, then resolve permissions, then — finally — read the records. Four
 * round trips in series, and only the first of them was ever load-bearing. The
 * other three need nothing but the session's user id, and every row they return
 * is scoped by row-level security rather than by the role being resolved beside
 * them.
 *
 * That is a latency the user pays on every navigation, and it is invisible in
 * review: `await a; await b` reads exactly as well as `await Promise.all([a, b])`
 * and costs twice as much. So the SHAPE is asserted here, per file, and a future
 * edit that re-serializes one of these fails rather than quietly slowing a page
 * back down.
 *
 * WHAT THIS DOES NOT CLAIM. Not milliseconds. What is counted is SEQUENTIAL
 * AWAIT GROUPS on the startup path — how many times the screen waits for a
 * network answer before it can draw. That is a property of the source, it is
 * what changed, and it is the honest unit for a change that removed waiting
 * rather than work: the number of QUERIES is deliberately unchanged everywhere.
 *
 * AND NOT ONE AUTHORITY MOVED. Every capability is still resolved by
 * resolve_effective_permissions / resolve_permission in the database, still
 * applied before any control renders, and still fails closed. Section 4 is what
 * keeps that true.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderStartupShape.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with its LINE comments removed.
 *
 * Only line comments. A block-comment stripper looks tidier and is wrong here:
 * these files are two-thousand-line JSX, and a `/*` or `*\/` inside a string, a
 * regex or a JSX expression makes it swallow real code — it silently ate the
 * whole of the Order Requests page while this test was being written.
 *
 * Doc comments therefore survive, so every assertion below matches on something
 * that cannot appear in prose: `await Promise.all([`, a `.from('users')` call, a
 * concrete expression. None of them can be satisfied by a sentence.
 */
const stripComments = (source: string): string =>
  source
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const GUARD = 'src/app/orders/layout.tsx'
const DASHBOARD = 'src/app/orders/page.tsx'
const ALL = 'src/app/orders/all/page.tsx'
const DETAIL = 'src/app/orders/[id]/page.tsx'
const DRAFTS = 'src/app/orders/drafts/page.tsx'
const PI_DETAIL = 'src/app/orders/drafts/[submissionId]/page.tsx'
const REQUESTS = 'src/app/orders/requests/page.tsx'
const REQUEST_DETAIL = 'src/app/orders/requests/[id]/page.tsx'
const IMPORT = 'src/app/orders/import/page.tsx'

/**
 * The body of the STARTUP function — the one that redirects to /login.
 *
 * Found by brace-matching from the arrow function that contains that redirect,
 * because several of these files legitimately call getSession() elsewhere (a
 * status change, a payment write), and the first one in the file is not always
 * the one a person is waiting for.
 */
function startup(path: string): string {
  const source = stripComments(read(path))

  const loginAt = source.search(/router\.(push|replace)\('\/login'\)/)
  assert.ok(loginAt > 0, `${path}: no login redirect, so no startup path this test can find`)

  // The nearest `async () => {` before it.
  const open = source.lastIndexOf('async () => {', loginAt)
  assert.ok(open > 0, `${path}: the startup path is not an arrow function`)

  let depth = 0
  let at = source.indexOf('{', open)
  const from = at
  for (; at < source.length; at++) {
    if (source[at] === '{') depth += 1
    else if (source[at] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  assert.ok(at < source.length, `${path}: unbalanced braces on the startup path`)
  return source.slice(from, at + 1)
}

/**
 * How many times the startup path waits for the network.
 *
 * One per `await`. An `await Promise.all([...])` counts ONCE however many
 * queries are inside it — which is the whole point of the change this pins.
 */
function waits(body: string): number {
  return (body.match(/\bawait\b/g) ?? []).length
}

/** Every query the FILE issues, wherever it sits. Counted across the whole
 *  source rather than the effect, because most screens issue theirs from a
 *  named loader the effect calls — and what matters is that the total did not
 *  move. */
function queryCount(path: string): number {
  const source = stripComments(read(path))
  return (source.match(/\.from\(|\.rpc\(|getEffectivePermissions\(|hasPermission\(/g) ?? []).length
}

// ══ 1. The guard every Order screen waits behind ═════════════════════════════

describe('the Orders layout guard', () => {
  const body = startup(GUARD)

  test('asks its two questions TOGETHER', () => {
    // It renders a loading state instead of its children, so every round trip it
    // spends is spent by all nine Order routes.
    assert.match(body, /await Promise\.all\(\[/)
    assert.equal(waits(body), 2, 'the session, then both questions at once')
  })

  test('and it is still exactly two queries, not one', () => {
    assert.equal(queryCount(GUARD), 2)
  })

  test('and still asks BOTH of them', () => {
    assert.match(body, /\.from\('users'\)/)
    assert.match(body, /hasPermission\(supabase, session\.user\.id, 'orders', 'view'\)/)
  })

  test('THE RULE IS UNCHANGED: admin by role, everybody else by resolve_permission', () => {
    assert.match(body, /profile\.role === 'admin' \|\| viewAllowed/)
    // A failed permission read still denies, and a missing profile still denies.
    assert.match(body, /\.catch\(\(\) => false\)/)
    assert.match(body, /!!profile &&/)
  })

  test('and it still blocks its children until it has answered', () => {
    const source = stripComments(read(GUARD))
    assert.match(source, /if \(!authorized\) return <LoadingScreen \/>/)
  })
})

// ══ 2. Every screen's own startup ════════════════════════════════════════════

/**
 * MEASURED, not estimated — from the source at origin/main and from the source
 * here, by the same counter this test uses.
 *
 *   screen                        before   after
 *   ─────────────────────────────────────────────
 *   the Orders layout guard          3       2      (paid by ALL nine routes)
 *   /orders                          4       2
 *   /orders/all                      3       2
 *   /orders/[id]                     5       3
 *   /orders/drafts                   4       3
 *   /orders/drafts/[submissionId]    4       3
 *   /orders/requests                 4       2
 *   /orders/requests/[id]            4       2
 *   /orders/import                   4       4      (deliberately untouched)
 *
 * The guard blocks its children, so what a person actually waits through is
 * guard + screen: /orders went from 7 to 4, the Order detail from 8 to 5, both
 * request screens from 7 to 4.
 */
const SCREENS: { path: string; label: string; waits: number; before: number }[] = [
  { path: DASHBOARD,      label: 'the Orders dashboard', waits: 2, before: 4 },
  { path: ALL,            label: 'All Orders',           waits: 2, before: 3 },
  { path: DETAIL,         label: 'the Order detail',     waits: 3, before: 5 },
  { path: DRAFTS,         label: 'PI Drafts',            waits: 3, before: 4 },
  { path: PI_DETAIL,      label: 'the PI detail',        waits: 3, before: 4 },
  { path: REQUESTS,       label: 'Order Requests',       waits: 2, before: 4 },
  { path: REQUEST_DETAIL, label: 'the request detail',   waits: 2, before: 4 },
]

describe('no Order screen waits more than it must', () => {
  for (const screen of SCREENS) {
    test(`${screen.label} waits ${screen.waits} time(s), where it waited ${screen.before}`, () => {
      const body = startup(screen.path)
      assert.equal(waits(body), screen.waits,
        `${screen.path}: startup waits changed — if that is deliberate, the number here moves with it`)
      assert.ok(screen.waits < screen.before, 'and it must not have gone back up')
    })
  }

  test('and every one of them opens with Promise.all', () => {
    for (const screen of SCREENS) {
      assert.match(startup(screen.path), /await Promise\.all\(\[/, screen.path)
    }
  })

  test('NOTHING WAS DROPPED to get there — the queries are the queries', () => {
    // The point of the change: the same questions, asked of the same database,
    // with the waiting removed. These counts are the whole file's, so a query
    // moved out of the effect into a loader still shows up.
    //
    // /orders/[id] is the one that legitimately grew — from 10 to 17 — and not
    // from this pass: the Confirmed Order handoff and the document register are
    // new READS on a screen that previously showed neither. Its startup still
    // waits three times, not seventeen.
    const expected: Record<string, number> = {
      [GUARD]: 2, [DASHBOARD]: 9, [ALL]: 2, [DETAIL]: 17,
      // PI_DETAIL went 19 -> 20: can_admin_edit_order_submission, the second
      // capability probe added in 20260927000000. It is resolved INSIDE the
      // page's existing Promise.all, so the count grew and the number of times
      // the page waits did not.
      [DRAFTS]: 4, [PI_DETAIL]: 20, [REQUESTS]: 18, [REQUEST_DETAIL]: 7, [IMPORT]: 5,
    }
    for (const [path, count] of Object.entries(expected)) {
      assert.equal(queryCount(path), count, path)
    }
  })
})

// ══ 3. The two that legitimately still wait ══════════════════════════════════

describe('where an ordering IS load-bearing, it is kept', () => {
  test('PI Drafts reads its list AFTER the permissions', () => {
    // Which ids the list resolves names for depends on whether this viewer is a
    // reviewer, which is what the permissions answer. Starting the list early
    // would mean reading it twice or resolving the wrong names.
    const body = startup(DRAFTS)
    assert.ok(body.indexOf('getEffectivePermissions') < body.indexOf('load()'),
      'the draft list depends on the reviewer answer')
  })

  test('the PI detail reads its draft AFTER the permissions, for the same reason', () => {
    const body = startup(PI_DETAIL)
    assert.ok(body.indexOf('getEffectivePermissions') < body.indexOf('loadDraft()'))
  })

  test('the Order detail asks for cleanup settings only AFTER the profile, and only of an admin', () => {
    const source = stripComments(read(DETAIL))
    assert.match(source, /role === 'admin'\)\s*\{\s*const \{ data: s \} = await supabase\.rpc\('get_test_data_cleanup_settings'\)/)
  })

  test('the import screen is deliberately UNTOUCHED', () => {
    // finalApprovalScope.test.ts holds this file byte-for-byte against
    // origin/main outside one card, because a whole phase promised to change
    // nothing about uploading a PI. One saved round trip on a screen whose next
    // step is a person choosing a file from their disk is not worth weakening
    // that guard, so it was left exactly as it was.
    const body = startup(IMPORT)
    assert.ok(!/await Promise\.all\(\[/.test(body))
    assert.equal(waits(body), 4, 'unchanged from origin/main')
  })
})

// ══ 4. Nothing was cached, derived, or moved out of the database ═════════════

describe('what did NOT change', () => {
  const ALL_SCREENS = [GUARD, DASHBOARD, ALL, DETAIL, DRAFTS, PI_DETAIL, REQUESTS, REQUEST_DETAIL, IMPORT]

  test('no screen caches a profile, a permission or a record across a load', () => {
    // USAGE, not the WORD. Several of these files promise in prose never to
    // touch browser storage, and doc comments survive the line-based stripper —
    // so this looks for a member access, which prose does not contain.
    for (const path of ALL_SCREENS) {
      const source = stripComments(read(path))
      for (const forbidden of [/\blocalStorage\s*\./, /\bsessionStorage\s*\./, /\bindexedDB\s*\./, /\bstaleTime\s*:/]) {
        assert.ok(!forbidden.test(source), `${path} introduced ${forbidden}`)
      }
    }
  })

  test('every capability is still resolved by the database, never inferred', () => {
    for (const path of [DASHBOARD, DETAIL, DRAFTS, PI_DETAIL, IMPORT]) {
      const source = stripComments(read(path))
      assert.ok(source.includes('getEffectivePermissions('), path)
      // Never a role literal standing in for a permission.
      assert.ok(!/canApprove\w*\s*=\s*.*role === 'admin'/.test(source), path)
    }
  })

  test('the loading gate still waits for the capabilities before it clears', () => {
    // A page that drew before its permissions landed would flash controls the
    // viewer may not have — which is worse than the latency this removed.
    for (const path of [DASHBOARD, DETAIL]) {
      const body = startup(path)
      const permsAt = body.indexOf('deriveOrdersCapabilities(')
      const clearAt = body.indexOf('setPageLoading(false)')
      assert.ok(permsAt > 0, `${path}: capabilities are resolved on the startup path`)
      assert.ok(clearAt > permsAt,
        `${path}: capabilities must be applied before the loading gate clears`)
    }
  })

  test('nothing refetches merely because the tab regained focus', () => {
    // Already true before this pass — an earlier phase removed the listener and
    // configured React Query. Asserted here too, because a "make it feel fresh"
    // change is exactly what a performance pass tempts somebody into.
    for (const path of ALL_SCREENS) {
      const source = stripComments(read(path))
      for (const trigger of ['visibilitychange', "addEventListener('focus'", 'pageshow', 'setInterval(']) {
        assert.ok(!source.includes(trigger), `${path} added ${trigger}`)
      }
    }
  })

  test('no screen reads `select(\'*\')`', () => {
    for (const path of ALL_SCREENS) {
      assert.ok(!stripComments(read(path)).includes(".select('*')"), path)
    }
  })
})

// ══ 5. Two smaller changes in the same pass ══════════════════════════════════

describe('the Order lists prefetch what a hover says is coming', () => {
  for (const path of [DASHBOARD, ALL]) {
    test(`${path} prefetches the Order detail route on row hover`, () => {
      const source = stripComments(read(path))
      assert.match(source, /router\.prefetch\(`\/orders\/\$\{o\.id\}`\)/, path)
    })

    test(`${path} prefetches the ROUTE and reads no record`, () => {
      // A prefetch that fetched DATA would be a cache of a private row, and the
      // brief forbids exactly that. This fetches the screen's code; every read
      // still happens when the page mounts, under the reader's own session.
      const source = stripComments(read(path))
      const at = source.indexOf('router.prefetch(')
      const around = source.slice(at, at + 200)
      assert.ok(!/\.from\(|\.rpc\(/.test(around), `${path}: a prefetch must not read a record`)
    })
  }
})

describe('product photographs were deliberately LEFT ALONE', () => {
  const preview = 'src/components/orders/piPreview.tsx'

  test('piPreview.tsx is byte-for-byte what origin/main has', () => {
    // decoding="async" WAS ADDED to both <img> elements and then reverted.
    //
    // finalApprovalScope.test.ts holds this file byte-for-byte, and its reason
    // is a good one: piPreview.tsx is shared with the import preview, so a
    // change here changes two screens — and one of those screens is the same
    // one a whole phase promised not to touch.
    //
    // Moving image decode off the paint is a real improvement on a PI with
    // forty photographs, and it is not worth weakening a guard that stands
    // between a performance pass and the two screens a PI is read on. Recorded
    // here so the option, and the reason it was refused, are both findable.
    const base = execFileSync('git', ['show', `origin/main:${preview}`], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).replace(/\r\n/g, '\n')
    assert.equal(read(preview).replace(/\r\n/g, '\n'), base)
  })

  test('and are still a plain <img>, never the optimizer', () => {
    // The source is a blob: URL or a short-lived signed URL for a private
    // object, and neither is something next/image can or should fetch.
    const imports = read(preview)
      .split('\n').filter(line => line.trimStart().startsWith('import'))
    assert.ok(!imports.some(line => line.includes('next/image')))
  })
})
