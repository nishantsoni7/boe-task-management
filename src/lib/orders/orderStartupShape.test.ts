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
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

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
/**
 * The retired Order Request routes now render one notice component, and it has a
 * startup path of its own — so it is measured here like any other screen. The
 * two page files are thin wrappers with no session work at all.
 */
const RETIRED_NOTICE = 'src/app/orders/requests/RetiredWorkflowNotice.tsx'
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
 *
 * THE TWO REQUEST SCREENS ARE NOW ONE NOTICE. Their workflow is retired
 * (20261007000000) and both routes render RetiredWorkflowNotice, which keeps the
 * same two-wait shape: the session, then one parallel group holding the profile
 * and the provenance lookup.
 */
const SCREENS: { path: string; label: string; waits: number; before: number }[] = [
  { path: DASHBOARD,      label: 'the Orders dashboard', waits: 2, before: 4 },
  { path: ALL,            label: 'All Orders',           waits: 2, before: 3 },
  { path: DETAIL,         label: 'the Order detail',     waits: 3, before: 5 },
  { path: DRAFTS,         label: 'PI Drafts',            waits: 3, before: 4 },
  { path: PI_DETAIL,      label: 'the PI detail',        waits: 3, before: 4 },
  { path: RETIRED_NOTICE, label: 'the retired-workflow notice', waits: 2, before: 4 },
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
    //
    // DETAIL 18 -> 19: payment_active_allocation_totals, the batched fact the
    // canonical attribution rule turns on — whether a payment has active
    // allocations ELSEWHERE, which this screen cannot see for itself. ONE call
    // for every payment on the page, never one per row. It necessarily follows
    // the payment reads, because it is keyed on the ids they return, so the
    // page's WAIT COUNT is unchanged: the test above still requires three.
    //
    // DETAIL 17 -> 18: the 'finance' effective-permission resolve, which decides
    // ONE thing — whether a payment row draws a link into its Finance record.
    // It was added INSIDE the page's existing Promise.all, alongside the
    // 'orders' resolve it already made, so the count grew and the number of
    // times the page waits did NOT: the test above still requires exactly three,
    // and a fourth independent call in a group that already waits for the
    // slowest costs no latency.
    //
    // DETAIL 19 -> 27 (20261119000000). Three READS inside the handoff's
    // existing Promise.all — order_pi_versions, the source PI's
    // order_submission_activity, and the one users read that names both — so
    // the startup wait count is unchanged (the test above still requires
    // three). Three SAVES that run when somebody presses a control:
    // propose_order_pi_revision, reject_order_pi_revision and
    // set_order_production_alignment. And two storage calls on a click: the
    // signer for any version's workbook, and the upload of a revised one.
    //
    // DETAIL 27 -> 28 (20261124000000): order_product_codes, one more READ
    // inside the handoff's existing Promise.all, so the Order's permanent BOE
    // item codes arrive alongside its PI items rather than in a fourth wait.
    // The startup wait count is unchanged.
    //
    // DETAIL 28 -> 29 (20261202000000): the reader's own unread Order-update
    // notifications for THIS Order, read once on open so the Activity trail can
    // mark what is new to them before those rows are marked read. It runs LAST,
    // after the loading gate has cleared and the page is already on screen, and
    // nothing awaits it — so the startup wait count is unchanged and the test
    // above still requires exactly three.
    const expected: Record<string, number> = {
      // DASHBOARD went 9 -> 11 when the Order Request card and its count were
      // replaced by the workflow the dashboard now describes: PI Drafts, the
      // review queue, awaiting-verification money and available funds. All of
      // them are issued INSIDE the page's existing Promise.all, so the count
      // grew and the number of times the page waits did not — which is the whole
      // property this block exists to protect.
      // ALL 2 -> 3 (20261202000000): the reader's own unread Order-update
      // notifications, which decide the NEW UPDATE badge. It is issued INSIDE
      // the page's existing Promise.all, beside the profile and the Orders
      // read, so the count grew and the number of times the page waits did NOT
      // — the wait test above still requires exactly two.
      // DASHBOARD 11 -> 10: the Overdue card was removed, and with it the one
      // count that fed only that card. The wait count is unchanged.
      // DETAIL 29 -> 27, AND THIS IS THE FIRST TIME IT HAS GONE DOWN twice
      // over: the Documents section and the Generate Document control left the
      // Confirmed Order screen, taking the order_document_versions read and the
      // document download's signer with them. The register, its route and its
      // RLS are untouched — the screen simply stopped asking.
      //
      // DETAIL 27 -> 31 (20261227000000, the status workspace). FOUR, and not
      // one of them is on the startup path:
      //
      //   +1  order_approval_events, the fabric/finish log. Issued INSIDE the
      //       page's existing Promise.all, beside the activity trail and the
      //       change requests, so the count grew and the number of times the
      //       page waits did NOT — the wait test above still requires exactly
      //       three.
      //   +1  the ERP screenshot's signer, fired from the card's own control.
      //   +1  the screenshot upload, fired from the update dialog.
      //   +1  record_order_approval_event, the write that dialog performs.
      //
      // The last three are a SAVE and two on-demand file operations. None runs
      // at load, and no archived PI version or stored proof is signed until
      // somebody names it.
      //
      // DETAIL 31 -> 32: the orphan removal. The screenshot has to be uploaded
      // BEFORE record_order_approval_event(), because that function refuses a
      // path naming no object — so every refusal strands the file uploaded for
      // it. This call takes that one file back, and it runs ONLY in the
      // refusal arm of a write somebody pressed. Nothing at load, nothing on a
      // success, and the bucket's DELETE policy cannot reach a screenshot an
      // event has already filed. The wait count is unchanged: the test above
      // still requires exactly three.
      //
      // DETAIL 32 -> 31: the Order records section left the page, and the
      // source-PI workbook's own signer went with it — the one `.from()` it
      // issued was against the storage bucket, fired from that section's
      // Download. The DOCUMENT is unaffected: the PI in force is downloaded
      // from the Main PI card, through openVersionFile's signer, which is
      // counted here already. Nothing at load either way; this screen simply
      // stopped offering the same file through two doors.
      //
      // DETAIL 31 -> 32: one payment's Finance record, fetched when somebody
      // presses View details. It is the RESTORATION of a boundary rather than a
      // new feature: those columns were briefly selected for every payment on
      // the startup path, which put Finance's notes about every payment into
      // every reader's browser. They are a separate read now — ONE row, on a
      // press, refused outright unless the reader holds Finance module entry AND
      // the id is one this Order's own list already showed. Nothing at load, and
      // the wait count is unchanged: the test above still requires exactly three.
      //
      // THE PI-TO-OPERATIONS HANDOFF (20261229000000):
      //
      // DASHBOARD 10 -> 13: three `head: true` counts over the reader's live
      //   handoffs — awaiting and addressed to them, awaiting and addressed to
      //   nobody, and flagged for clarification (unresolved work, whoever it
      //   is addressed to). All sit INSIDE the existing Promise.all, so the
      //   number of times the dashboard waits is unchanged (the wait test
      //   above still says two).
      // ALL 3 -> 4: the ?ops=awaiting queue's one read of the live handoffs,
      //   issued beside the list and the badge in the same group — and only
      //   when that filter is in the URL; a plain /orders/all still makes
      //   three.
      // DETAIL 32 -> 34: one read of the Order's handoffs, in the SAME group
      //   as the PI versions it is about (so the page still waits exactly
      //   three times), and decide_order_operations_handoff — a SAVE, fired
      //   from the decision dialog, never at load.
      // DETAIL 34 -> 36 (20270101000000): order_pi_revision_differences, read
      //   when the operations reviewer OPENS the revision review, and
      //   decide_order_pi_revision_operations, fired from that dialog. Neither
      //   runs at load, so the page still waits exactly three times.
      // DETAIL 36 -> 37 (20270101000000 §6b): reapprove_order_pi_revision, a
      //   SAVE fired from an admin's confirmed Re-approve, and only when the
      //   admin who approved the revision is no longer active. Nothing at load.
      // DETAIL 37 -> 39 (20270104000000 §4d): order_advance_readiness, read
      //   alongside the load but NOT awaited by it (the page still waits
      //   exactly three times), and approve_order_advance_exception, a SAVE
      //   fired from an admin's confirmed "Approve production below 40%".
      // DETAIL 39 -> 40 (20270104000000, review R1):
      //   recover_order_production_alignment, a SAVE fired from an admin's
      //   confirmed "Recover production alignment…", offered only when no
      //   operations reviewer can align a held Order again. Nothing at load.
      [GUARD]: 2, [DASHBOARD]: 13, [ALL]: 4, [DETAIL]: 40,
      // PI_DETAIL went 19 -> 20: can_admin_edit_order_submission, the second
      // capability probe added in 20260927000000. It is resolved INSIDE the
      // page's existing Promise.all, so the count grew and the number of times
      // the page waits did not.
      // PI_DETAIL 20 -> 22, both SAVES rather than loads:
      // update_order_submission_client_details and
      // update_order_submission_schedule_terms. They run when somebody presses
      // Save in the editor, so the count grew and the startup path did not.
      // 22 -> 23: request_order_submission_correction, another SAVE.
      // 23 -> 25: update_order_submission_item_details and
      // reorder_order_submission_items — the product editor, and both SAVES
      // again. One runs when a line's description is saved, the other when the
      // lines are reordered; neither is on the startup path, so the page still
      // waits exactly as many times as it did.
      // The two Order Request screens carried 18 and 7 reads between them; both
      // are retired (20261007000000) and replaced by one notice that makes TWO:
      // the reader's profile, and a provenance lookup that names the Confirmed
      // Order a converted request became — where the reader can already open it.
      // PI_DETAIL 25 -> 26: reserve_order_number_for_submission, which runs when
      // somebody presses Reserve. A SAVE, not a load — the reserved number
      // itself arrives with the record, in the one read the page already makes,
      // because its columns are spread into PI_DRAFT_DETAIL_COLUMNS. So the
      // count grew and the startup path did not: the wait test above is
      // unchanged.
      // PI_DETAIL 26 -> 27: approve_pi_review (20261119000000), the PI decision
      // taken on its own. A SAVE that runs when the reviewer presses Approve
      // PI; the decision itself arrives with the record, because its three
      // columns are spread into PI_DRAFT_DETAIL_COLUMNS. The startup path is
      // unchanged.
      // PI_DETAIL 27 -> 28 (20261201000000): ONE users read, for the list of
      // people who may be named as the SALESPERSON on the Order this PI
      // becomes. Four fields are now required to create an Order — salesperson,
      // confirm date, due date and lead source — and the first of them needs a
      // list to choose from. It is issued INSIDE the page's existing
      // Promise.all, beside the profile and the two permission resolves, so the
      // count grew and the number of times the page waits did NOT: the wait
      // test above still requires exactly three.
      // IMPORT 5 -> 8 (20261219000000, launch audit): a failed save discards
      // the unsaved draft it created — one read of the row's stored workbook
      // key, one removal of the object this attempt uploaded, and
      // discard_unsaved_order_submission. All three run only AFTER a failure or
      // on leaving the screen; none is on the startup path.
      // PI_DETAIL 28 -> 29 (20261225000000): update_order_submission_pi_terms,
      // the PI terms editor — date of creation, commercial terms note and who
      // provides the fabric. A SAVE, fired from a dialog, exactly like the
      // client and schedule editors beside it. The three values arrive with
      // the record, because their columns are spread into
      // PI_DRAFT_DETAIL_COLUMNS, so the startup path is unchanged and the
      // wait test above still requires exactly three.
      // PI_DETAIL 29 -> 28 (20261226000000), and it is the FIRST TIME THIS
      // COUNT HAS GONE DOWN. verify_pi_finance_check is gone: the PI-level
      // finance sign-off it recorded is no longer a step, so the page no longer
      // calls it. A SAVE rather than a load, so the startup path is unchanged
      // and the wait test above still requires exactly three — what changed is
      // that this screen now makes one fewer write of any kind.
      // PI_DETAIL 28 -> 27 (20261231000000). The submit call MOVED, it did not
      // go: submit_pi_for_review is now reached through the supporting-
      // documents sender (src/components/orders/PiSupportingDocuments.tsx),
      // which uploads the attached Design Files / Client PO and calls
      // submit_pi_for_review_with_documents. A SAVE on a press, so the startup
      // path is unchanged and the wait test above still requires three.
      // PI_DETAIL 27 -> 26 (20270102000000): reserve_order_number_for_submission
      // is retired — a PI Draft no longer reserves a number, so the page's
      // Reserve action and its one RPC went with it. A write on a press, never
      // on the startup path.
      [DRAFTS]: 4, [PI_DETAIL]: 26, [RETIRED_NOTICE]: 3, [IMPORT]: 8,
    }
    for (const [path, count] of Object.entries(expected)) {
      assert.equal(queryCount(path), count, path)
    }
  })
})

// ══ 3. The two that legitimately still wait ══════════════════════════════════

describe('where an ordering IS load-bearing, it is kept', () => {
  test('PI Drafts resolves its NAMES after the permissions — the rows travel with them', () => {
    // THE LOAD-BEARING PART IS THE NAMES, NOT THE ROWS. Which ids the list
    // resolves names for depends on whether this viewer is a reviewer, which is
    // what the permissions answer — so that read must stay downstream of them.
    //
    // The ROWS never depended on it: which submissions come back is RLS's
    // answer, not a role's. This test used to pin the rows behind the
    // permissions as a proxy for the names, which cost a whole round trip on
    // every open of the screen for a dependency that was not there. The query
    // now travels WITH the profile and the permissions and its answer is handed
    // to the loader, so nothing is read twice and no name is resolved early.
    const body = startup(DRAFTS)
    assert.ok(body.indexOf('getEffectivePermissions') < body.indexOf('reviewerRef.current ='),
      'the reviewer answer must be written before the loader reads it')
    assert.ok(body.indexOf('reviewerRef.current =') < body.indexOf('load(drafts)'),
      'and written before the names are resolved')

    const page = read(DRAFTS)
    assert.ok(page.includes('draftsQuery(),'),
      'the rows are issued in the group, not after it')
    assert.equal((page.match(/draftsQuery\(\)/g) ?? []).length, 2,
      'one definition site and one early call: a third would mean a double read')
    assert.ok(page.indexOf('reviewerRef.current') < page.indexOf("from('users')"),
      'the names are still chosen by the reviewer answer, not before it')
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
  const ALL_SCREENS = [GUARD, DASHBOARD, ALL, DETAIL, DRAFTS, PI_DETAIL, RETIRED_NOTICE, IMPORT]

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

describe('PI Drafts prefetches too — it was the one list that did not', () => {
  // The two Order lists gained this in their own pass and the draft list was
  // left behind, so a screen an approver opens constantly was the slowest to
  // arrive. Same rule as theirs: the ROUTE, never the record. A prefetch that
  // fetched DATA would be a cache of a private row.
  const source = stripComments(read(DRAFTS))

  test('a hover on a draft row prefetches the PI detail route', () => {
    assert.ok(source.includes('router.prefetch(entry.href)'),
      'the list must prefetch what a hover says is coming')
    assert.ok(source.includes('onMouseEnter={() => prefetchDraft(entry)}'),
      'and it must be wired to the control that opens the draft')
  })

  test('it prefetches the ROUTE and reads no record', () => {
    const at = source.indexOf('router.prefetch(')
    const around = source.slice(at, at + 200)
    for (const read of ['.from(', '.rpc(']) {
      assert.ok(!around.includes(read), 'a prefetch must not read a record')
    }
  })
})

describe('product photographs were deliberately LEFT ALONE', () => {
  const preview = 'src/components/orders/piPreview.tsx'

  test('no performance pass reached the pictures a PI is read from', () => {
    // decoding="async" WAS ADDED to both <img> elements and then reverted.
    //
    // Moving image decode off the paint is a real improvement on a PI with
    // forty photographs, and it is not worth changing the two screens a PI is
    // read on to get it. Recorded here so the option, and the reason it was
    // refused, are both findable.
    //
    // WHY THIS IS NO LONGER A WHOLE-FILE COMPARISON. piPreview.tsx also holds
    // PiCommercialSummary, which the authorized PI preview refinement
    // redesigned — so the file moved for a reason that has nothing to do with
    // image decode, and a byte comparison would now fail for that reason alone
    // while saying nothing about pictures. The part this test is FOR is
    // everything above the commercial summary: the thumbnails, their sizes, the
    // customization cell, the columns, the table head and the full-size viewer.
    // That part is still held byte-for-byte against origin/main.
    const lf = (s: string) => s.replace(/\r\n/g, '\n')
    const upToCommercial = (source: string, label: string) => {
      const at = source.indexOf('// ── The commercial summary ─')
      assert.notEqual(at, -1, `${label}: the commercial summary marker must still be there`)
      return source.slice(0, at)
    }
    const base = lf(execFileSync('git', ['show', `origin/main:${preview}`], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }))
    assert.equal(upToCommercial(lf(read(preview)), 'current'), upToCommercial(base, 'origin/main'))

    // And the property itself, stated directly rather than through the proxy,
    // so it holds for the whole file however the file is later reorganised.
    const source = read(preview)
    // On their own line, which is how both are written — so the one `<img>` in
    // a prose comment is not counted as a third element.
    assert.equal((source.match(/^\s*<img$/gm) ?? []).length, 2, 'still exactly two <img> elements')
    assert.ok(!/decoding=|loading=|fetchPriority=/.test(source),
      'no decode, lazy-load or priority hint was added to a PI photograph')
  })

  test('and are still a plain <img>, never the optimizer', () => {
    // The source is a blob: URL or a short-lived signed URL for a private
    // object, and neither is something next/image can or should fetch.
    const imports = read(preview)
      .split('\n').filter(line => line.trimStart().startsWith('import'))
    assert.ok(!imports.some(line => line.includes('next/image')))
  })
})

// ══ 6. What a mutation re-reads ══════════════════════════════════════════════

describe('a status change re-reads what it changed, and not the whole page', () => {
  const detail = stripComments(read(DETAIL))

  test('the write answers for itself — the stored row comes back', () => {
    // THE DEFECT A NARROW REFRESH INTRODUCES IF THE WRITE IS NOT AUTHORITATIVE:
    // `updated_at` is written by the set_updated_at TRIGGER and displayed as
    // "Last Updated". Applying the status that was ASKED for, and re-reading
    // only the activity log, would leave a stale timestamp beside a fresh
    // status. The row is read back by the update itself, so this costs no
    // extra round trip and no trigger-written value is ever assumed.
    assert.match(detail, /\.update\(\{ status: newStatus \}\)[\s\S]{0,300}?\.select\('status, updated_at'\)/,
      'the update must return the row it stored')
    assert.ok(detail.includes('setOrder(o => o ? { ...o, ...updated } : o)'),
      'and the page must apply the DATABASE\'s values, not the requested one')
    // THE TIMESTAMP IS NO LONGER ON SCREEN, and the rule is unchanged anyway.
    //
    // Record Information was removed (20261202000000) and its two timestamps
    // moved into Important Dates; the six-field summary panel then replaced
    // Important Dates, and neither `Created` nor `Last updated` is drawn — the
    // reasoning is in the page, and the architecture test pins that both
    // columns are still READ.
    //
    // So this no longer asserts where updated_at renders. It asserts the thing
    // that actually protects the narrow refresh: the page applies what the
    // DATABASE returned and never the value it asked for. A trigger-written
    // column that is carried on the row must be the stored one whether or not
    // some later section decides to print it.
    assert.match(detail, /const \{ data: updated \}|onStatusChanged=\{updated =>/,
      'the stored row is what flows back into state')
    assert.equal(/setOrder\(o => o \? \{ \.\.\.o, status: newStatus \}/.test(detail), false,
      'the requested status must never be applied in place of the stored one')
  })

  test('a transition cannot apply against a status that has moved', () => {
    // Compare and swap. A second click that raced the first, or somebody else's
    // transition landing in between, matches no row and changes nothing —
    // rather than applying a move computed from a status that is no longer
    // true. `dispatched` is terminal, so a lost race is not recoverable by
    // simply trying again.
    assert.match(detail, /\.eq\('id', order\.id\)\s*\n?\s*\.eq\('status', oldStatus\)/,
      'the update must be conditional on the status this screen was showing')
    assert.ok(detail.includes('if (saving) return'),
      'and a second click is refused while the first is in flight')
  })

  test('a refused or superseded transition re-reads everything and changes nothing', () => {
    const fn = detail.slice(detail.indexOf('const doStatusChange'))
    const body = fn.slice(0, fn.indexOf('\n  }\n'))
    assert.ok(body.includes('if (error || !updated) {'),
      'no row back means the transition did not happen')
    assert.ok(/if \(error \|\| !updated\) \{[\s\S]{0,200}?onOutOfDate\(\)/.test(body),
      'and the screen resyncs rather than showing a change that was refused')
    const failAt = body.indexOf('if (error || !updated)')
    assert.ok(!body.slice(0, failAt).includes('setOrder('),
      'nothing is applied to the UI before the write is known to have succeeded')
    assert.ok(!body.slice(0, failAt).includes("from('order_activity_log')"),
      'and no activity row is written for a transition that did not happen')
    assert.ok(detail.includes('onOutOfDate={() => { loadOrder() }}'),
      'resync is the FULL reload — the screen cannot know which part went stale')
  })

  test('the activity entry records what was STORED, not what was asked', () => {
    const fn = detail.slice(detail.indexOf('const doStatusChange'))
    const body = fn.slice(0, fn.indexOf('\n  }\n'))
    assert.ok(body.includes('payload:    { from: oldStatus, to: updated.status }'),
      'the trail must not claim a transition the database did not make')
  })

  test('the status transition refreshes only the activity trail', () => {
    // THE DEFECT: a transition wrote `orders.status` — already applied to the
    // row in hand on the line above — and one order_activity_log entry, then
    // called loadOrder(), which re-reads the Order, the PI handoff and its
    // signed URLs, the legacy payments, the allocations, the activity log, the
    // document versions, the change requests and the batched allocation
    // totals. Ten round trips to learn one new row, on the control an
    // operations user presses most.
    assert.match(detail, /onStatusChanged=\{updated => \{[\s\S]{0,900}?reloadActivity\(\)/,
      'the status handler must take the narrow refresh')
    // The SUCCESS handler only. onOutOfDate is a sibling prop and legitimately
    // does reload everything, so the slice stops before it.
    const handler = detail.slice(detail.indexOf('onStatusChanged={updated =>'))
    const body = handler.slice(0, handler.indexOf('reloadActivity()'))
    assert.ok(!body.includes('loadOrder()'),
      'a SUCCESSFUL transition must not fall back to the full page load')
    assert.ok(body.includes('setOrder(o => o ? { ...o, ...updated } : o)'),
      'the row is applied from the answer the server gave, trigger-written columns included')
  })

  test('the narrow refresh reads the activity log and nothing else', () => {
    const fn = detail.slice(detail.indexOf('const reloadActivity ='))
    const body = fn.slice(0, fn.indexOf('\n  }\n'))
    assert.ok(body.includes('activityQuery()'), 'through the shared query')
    assert.ok(body.includes('setActivity(mapActivityRows('), 'and the shared mapping')
    for (const other of ['finance_payment_requests', 'finance_payment_allocations',
                         'order_document_versions', 'order_change_requests', 'loadPiHandoff']) {
      assert.ok(!body.includes(other), `${other} must not be re-read by a status change`)
    }
  })

  test('ONE definition of the activity read, shared by both paths', () => {
    // The full load and the narrow refresh must not be able to read or shape
    // the trail differently — a divergence would show a different history
    // depending on how the reader got there.
    assert.equal((detail.match(/\.from\('order_activity_log'\)\s*\n?\s*\.select\(/g) ?? []).length, 1,
      'the activity SELECT is written once')
    assert.equal((detail.match(/activityQuery\(\)/g) ?? []).length, 2,
      'and used by exactly the full load and the narrow refresh')
  })

  test('every path that CAN move commercial data still reloads everything', () => {
    // The narrowing is deliberately confined to the status transition. An
    // amendment, a cancellation and a change-request decision all rewrite
    // columns on the Order itself, so a narrow refresh there would leave the
    // screen stating figures the database no longer holds.
    const after = detail.slice(detail.indexOf('const afterChange'))
    const body = after.slice(0, after.indexOf('\n  }\n'))
    assert.ok(body.includes('loadOrder()'),
      'the amendment/cancel/change-request path keeps the full reload')
    assert.ok(!body.includes('reloadActivity()'),
      'and must not be narrowed to the trail alone')
  })

  test('the explicit Refresh control still re-reads the whole page', () => {
    // A person pressing Refresh is asking for everything, including anything
    // somebody else changed. That is the one guaranteed way back to a fully
    // fresh screen, and it must not be narrowed.
    assert.match(detail, /onRefresh=\{[^}]*loadOrder/,
      'the header Refresh must still call the full load')
  })
})
