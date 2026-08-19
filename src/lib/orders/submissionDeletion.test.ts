/**
 * Permanently deleting a PI: the rule, the copy, the failures, and the wiring.
 *
 * WHY THESE ARE WORTH TESTING. Every rule here is a rule about ABSENCE as much
 * as presence — a colleague must not be offered Delete on somebody else's draft,
 * nobody at all may be offered it on a PI under review, and no permission that
 * merely reveals or decides a PI may reach it. Absence is exactly what stops
 * being noticed on the third read of a JSX file.
 *
 * NONE OF THIS IS THE ACCESS CONTROL. public.delete_order_submission()
 * re-derives the actor, the ownership, the administrator check and the status
 * inside the database, under a row lock, on every call — and a guard trigger
 * refuses a direct DELETE even for the service role. What is asserted here is
 * that the SCREEN does not offer a control the database would refuse, and does
 * not hide one it would allow, and that the route between them attempts the two
 * halves in the order that fails recoverably.
 *
 * Pure functions, source text and migration files only. No DB, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/submissionDeletion.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DELETABLE_SUBMISSION_STATUSES,
  DELETE_PI_ARIA_LABEL,
  DELETE_PI_CANCEL_LABEL,
  DELETE_PI_CONFIRM_LABEL,
  DELETE_PI_DIALOG_TITLE,
  DELETE_PI_SUCCESS,
  DELETE_PI_WARNING,
  canDeleteSubmission,
  classifyDeletionError,
  deletionStatusLabel,
  describeDeletionFailure,
  submissionStatusIsDeletable,
  type DeletableSubmission,
  type DeletionActor,
} from './submissionDeletion'
import { PI_DRAFT_LIST_COLUMNS, PI_DRAFT_STATUSES } from './draftsView'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const MIGRATION = '20260914000000_order_submission_permanent_deletion.sql'
const APPLIED_PHASE_B = '20260913000000_order_submission_advance_exceptions.sql'

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const sql = () => read(join('supabase', 'migrations', MIGRATION))

const OWNER   = '11111111-1111-4111-8111-111111111111'
const OTHER   = '22222222-2222-4222-8222-222222222222'
const ADMIN   = '33333333-3333-4333-8333-333333333333'

const pi = (over: Partial<DeletableSubmission> = {}): DeletableSubmission => ({
  status: 'draft',
  created_by: OWNER,
  submitted_by: OWNER,
  ...over,
})

const owner:   DeletionActor = { userId: OWNER, isAdmin: false }
const other:   DeletionActor = { userId: OTHER, isAdmin: false }
const admin:   DeletionActor = { userId: ADMIN, isAdmin: true }
const nobody:  DeletionActor = { userId: null,  isAdmin: false }

// ── Status eligibility ────────────────────────────────────────────────────────

describe('which states a PI may be deleted from', () => {
  test('the three the business named, and no others', () => {
    assert.deepEqual([...DELETABLE_SUBMISSION_STATUSES], ['draft', 'needs_changes', 'rejected'])
  })

  test('a PI under review is not one of them', () => {
    assert.equal(submissionStatusIsDeletable('submitted'), false)
  })

  test('nor is an approved one', () => {
    assert.equal(submissionStatusIsDeletable('approved'), false)
  })

  test('an unknown or future status FAILS CLOSED', () => {
    // The list is an allow-list. Whatever a later phase invents is refused until
    // somebody deliberately writes it in — here and in the migration, together.
    for (const status of ['confirmed', 'cancelled', 'archived', 'in_production', '', 'DRAFT']) {
      assert.equal(submissionStatusIsDeletable(status), false, `"${status}" must be refused`)
    }
    assert.equal(submissionStatusIsDeletable(null), false)
    assert.equal(submissionStatusIsDeletable(undefined), false)
  })

  test('every status the product has is decided one way or the other', () => {
    // A status the list page can print but this module has never heard of would
    // be a silent gap. There is none.
    for (const status of PI_DRAFT_STATUSES) {
      const deletable = submissionStatusIsDeletable(status)
      assert.equal(deletable, ['draft', 'needs_changes', 'rejected'].includes(status),
        `${status} is decided deliberately`)
    }
  })
})

// ── The authorization matrix ──────────────────────────────────────────────────

describe('the whole authorization matrix, cell by cell', () => {
  const cells: [string, DeletionActor, string, boolean][] = [
    ['draft',         owner,  'owner',      true],
    ['draft',         admin,  'admin',      true],
    ['draft',         other,  'other user', false],
    ['needs_changes', owner,  'owner',      true],
    ['needs_changes', admin,  'admin',      true],
    ['needs_changes', other,  'other user', false],
    ['rejected',      owner,  'owner',      true],
    ['rejected',      admin,  'admin',      true],
    ['rejected',      other,  'other user', false],
    ['submitted',     owner,  'owner',      false],
    ['submitted',     admin,  'admin',      false],
    ['submitted',     other,  'other user', false],
    ['approved',      owner,  'owner',      false],
    ['approved',      admin,  'admin',      false],
    ['approved',      other,  'other user', false],
  ]

  for (const [status, actor, who, expected] of cells) {
    test(`${status} · ${who} → ${expected ? 'may delete' : 'may NOT delete'}`, () => {
      assert.equal(canDeleteSubmission(pi({ status }), actor), expected)
    })
  }
})

describe('what ownership means, and what it does not', () => {
  test('the record’s creator owns it', () => {
    assert.ok(canDeleteSubmission(pi({ created_by: OWNER, submitted_by: null }), owner))
  })

  test('so does the person it was submitted on behalf of', () => {
    // created_by and submitted_by are the pair can_edit_order_submission reads.
    // An assistant filing a PI must not lock it away from either of them.
    assert.ok(canDeleteSubmission(pi({ created_by: OTHER, submitted_by: OWNER }), owner))
  })

  test('a record owned by nobody is not owned by whoever is looking', () => {
    assert.equal(canDeleteSubmission(pi({ created_by: null, submitted_by: null }), owner), false)
  })

  test('an unresolved viewer is refused rather than assumed', () => {
    assert.equal(canDeleteSubmission(pi(), nobody), false)
    assert.equal(canDeleteSubmission(pi({ created_by: null, submitted_by: null }), nobody), false)
  })

  test('an admin needs no ownership, but still needs an eligible status', () => {
    assert.ok(canDeleteSubmission(pi({ created_by: OTHER, submitted_by: OTHER }), admin))
    assert.equal(
      canDeleteSubmission(pi({ status: 'submitted', created_by: OTHER, submitted_by: OTHER }), admin),
      false)
  })
})

// ── Non-escalation ────────────────────────────────────────────────────────────

describe('no permission reaches somebody else’s PI', () => {
  /** A colleague holding every Orders permission short of being an admin. */
  const wellGranted = deriveOrdersCapabilities('employee', [
    'view', 'view_all', 'create', 'edit', 'approve', 'approve_order',
    'approve_advance_exception', 'export', 'delete', 'manage',
  ].map(actionKey => ({ actionKey, allowed: true, source: 'role' as const })))

  test('the capability set is genuinely broad, so the denial means something', () => {
    assert.ok(wellGranted.canViewAllOrders)
    assert.ok(wellGranted.canApproveOrderSubmission)
    assert.ok(wellGranted.canApproveAdvanceException)
    assert.ok(wellGranted.canDeleteOrder)
    assert.ok(wellGranted.canManageOrders)
  })

  test('and none of it is an input to the deletion rule at all', () => {
    // The rule takes a status, an owner and an admin flag. There is no capability
    // parameter to pass, which is the strongest form this assertion can take:
    // a permission cannot escalate into a decision it is not consulted for.
    for (const status of DELETABLE_SUBMISSION_STATUSES) {
      assert.equal(
        canDeleteSubmission(pi({ status, created_by: OWNER, submitted_by: OWNER }), other),
        false,
        `${status}: a colleague is refused however well granted they are`)
    }
  })

  test('orders.delete is about Order Requests, and is not read here', () => {
    const source = read('src/lib/orders/submissionDeletion.ts')
    assert.ok(!source.includes('canDeleteOrder'))
    assert.ok(!source.includes("'delete'"))
    assert.ok(!source.includes('deriveOrdersCapabilities'))
  })

  test('nor is view_all, approve_order or approve_advance_exception', () => {
    const source = read('src/lib/orders/submissionDeletion.ts')
    for (const capability of ['canViewAllOrders', 'canApproveOrderSubmission',
                              'canApproveAdvanceException', 'canManageOrders']) {
      assert.ok(!source.includes(capability), `${capability} must not be consulted`)
    }
  })
})

// ── The confirmation copy ─────────────────────────────────────────────────────

describe('the confirmation says what is about to happen', () => {
  test('the title asks the question rather than announcing the deed', () => {
    assert.equal(DELETE_PI_DIALOG_TITLE, 'Delete PI?')
  })

  test('the buttons are Cancel and Delete PI', () => {
    assert.equal(DELETE_PI_CANCEL_LABEL, 'Cancel')
    assert.equal(DELETE_PI_CONFIRM_LABEL, 'Delete PI')
  })

  test('the warning names everything that goes, and says it is permanent', () => {
    assert.equal(DELETE_PI_WARNING,
      'This will permanently delete the PI, its workbook, product images and activity history. '
      + 'This action cannot be undone.')
    for (const thing of ['workbook', 'product images', 'activity history']) {
      assert.ok(DELETE_PI_WARNING.includes(thing), `${thing} must be named`)
    }
    assert.ok(/permanently/.test(DELETE_PI_WARNING))
    assert.ok(/cannot be undone/.test(DELETE_PI_WARNING))
  })

  test('the icon-only control carries a real accessible name', () => {
    assert.equal(DELETE_PI_ARIA_LABEL, 'Delete PI')
  })

  test('the status is shown in the words the rest of Orders uses', () => {
    assert.equal(deletionStatusLabel('needs_changes'), 'Needs Changes')
    assert.equal(deletionStatusLabel('rejected'), 'Rejected')
    // An unknown value renders as itself rather than as a lie about the record.
    assert.equal(deletionStatusLabel('something_new'), 'something_new')
    assert.equal(deletionStatusLabel(null), '—')
  })

  test('success is one short line, not a panel', () => {
    assert.equal(DELETE_PI_SUCCESS, 'PI deleted.')
  })
})

// ── Failures ──────────────────────────────────────────────────────────────────

describe('every failure becomes a stable code and a usable sentence', () => {
  test('the RPC markers map to the codes the screen branches on', () => {
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETE_DENIED: only the owner…')), 'FORBIDDEN')
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETE_STATUS: a PI in this state…')), 'STATUS_CHANGED')
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETE_MISSING: this PI no longer exists')), 'NOT_FOUND')
    assert.equal(classifyDeletionError(new Error('Authentication required')), 'UNAUTHORIZED')
    assert.equal(classifyDeletionError(new Error('This account is not active')), 'FORBIDDEN')
  })

  test('a status refusal is never answered as a permission refusal', () => {
    // Both markers begin ORDER_SUBMISSION_DELETE_. Order decides, so it is
    // asserted rather than left to the reading order of the table.
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETE_STATUS: … (this one is submitted)')), 'STATUS_CHANGED')
  })

  test('anything unrecognised falls back rather than leaking the database', () => {
    for (const raw of [null, undefined, '', {}, new Error('duplicate key value violates …')]) {
      const code = classifyDeletionError(raw)
      assert.equal(code, 'DELETE_FAILED')
    }
  })

  test('every code produces a sentence, and none of them is empty', () => {
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'STATUS_CHANGED', 'NOT_FOUND',
                        'STORAGE_CLEANUP_FAILED', 'DELETE_FAILED', 'nonsense', null]) {
      const failure = describeDeletionFailure(code)
      assert.ok(failure.message.length > 10, `${code} needs a real sentence`)
      assert.ok(!/error|exception|null|undefined|relation |column /i.test(failure.message),
        `${code} must not read like a database message`)
    }
  })

  test('the stale ones refresh the row; the others leave it alone', () => {
    assert.equal(describeDeletionFailure('STATUS_CHANGED').refresh, true)
    assert.equal(describeDeletionFailure('NOT_FOUND').refresh, true)
    assert.equal(describeDeletionFailure('FORBIDDEN').refresh, true)
    // Nothing was deleted and nothing about the row changed, so re-reading the
    // list would be a round trip that tells the employee nothing.
    assert.equal(describeDeletionFailure('STORAGE_CLEANUP_FAILED').refresh, false)
    assert.equal(describeDeletionFailure('UNAUTHORIZED').refresh, false)
  })

  test('a PI that entered review explains itself, rather than blaming the person', () => {
    const failure = describeDeletionFailure('STATUS_CHANGED')
    assert.ok(/under review/i.test(failure.message))
    assert.ok(/cannot be deleted/i.test(failure.message))
    assert.ok(/refreshed/i.test(failure.message))
  })

  test('a storage failure says plainly that NOTHING was deleted', () => {
    // The truth is what makes the retry safe. "Partly deleted" would leave
    // somebody guessing whether pressing it again does more damage.
    const failure = describeDeletionFailure('STORAGE_CLEANUP_FAILED')
    assert.ok(/nothing was deleted/i.test(failure.message))
  })
})

// ── The list ──────────────────────────────────────────────────────────────────

describe('the list can answer the ownership question it is asked', () => {
  test('it reads created_by as well as submitted_by', () => {
    assert.ok(PI_DRAFT_LIST_COLUMNS.includes('created_by'))
    assert.ok(PI_DRAFT_LIST_COLUMNS.includes('submitted_by'))
  })

  test('the control is drawn from the shared rule, not from a second copy', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes('canDeleteSubmission('))
    assert.ok(!/entry\.createdBy\s*===\s*\w+\s*\|\|/.test(page),
      'no hand-rolled ownership comparison in the page')
    assert.ok(!/status\s*===\s*'draft'\s*\|\|/.test(page),
      'no hand-rolled status list in the page')
  })

  test('Open Draft keeps its place and its wording', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes("renderList(working, 'Open Draft', false)"))
  })

  test('the destructive control is hidden, not disabled, when it does not apply', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(/if \(!canDeleteSubmission\([\s\S]{0,200}?\)\) return null/.test(page),
      'an ineligible row gets no control at all')
  })

  test('a repeat click cannot send a second request', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes('if (!entry || deletingRef.current) return'),
      'the ref stops a call already on its way')
    assert.ok(page.includes('deletingRef.current = true'))
    assert.ok(page.includes('disabled={deleting}'), 'and the button is disabled meanwhile')
  })

  test('success removes the row in place, with no full page reload', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes('setEntries(current => (current ?? []).filter(row => row.id !== entry.id))'))
    assert.ok(!page.includes('window.location.reload'))
    assert.ok(page.includes('setDeleted(DELETE_PI_SUCCESS)'))
  })

  test('a stale failure re-reads the list so the row shows the truth', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes('if (failure.refresh) await load()'))
  })

  test('the dialog is the shared component, not a second one', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes("import { PiDeleteConfirmModal } from '@/components/orders/piReviewModals'"))
    assert.ok(page.includes('<PiDeleteConfirmModal'))
  })
})

// ── The route ─────────────────────────────────────────────────────────────────

describe('the route reserves the record before it removes a single file', () => {
  const route = read('src/app/api/orders/submissions/delete/route.ts')

  test('the caller is authenticated from the session, never from the body', () => {
    assert.ok(route.includes('await authClient.auth.getUser()'))
    assert.ok(route.includes("return fail({ code: 'UNAUTHORIZED', status: 401 })"))
  })

  test('the submission id is validated before anything is read', () => {
    assert.ok(route.includes('SUBMISSION_ID_RE.test(submissionId)'))
  })

  test('cleanup is proven ATTEMPTABLE before anything is reserved or destroyed', () => {
    const guard = route.indexOf('if (!url || !serviceKey)')
    const begin = route.indexOf("rpc(\n    'begin_order_submission_deletion'")
    assert.ok(guard > 0 && begin > 0 && guard < begin,
      'a missing service key must not be discovered with a claim standing')
  })

  test('THE ORDER IS reserve → sweep → finalize', () => {
    const begin    = route.indexOf("'begin_order_submission_deletion'")
    const sweep    = route.indexOf('removeAllObjectsForSubmission(')
    const finalize = route.indexOf("'finalize_order_submission_deletion'")
    assert.ok(begin > 0 && sweep > begin && finalize > sweep,
      'the record must be frozen before a byte is touched, and erased only after')
  })

  test('THE DEFECT IT REPLACES IS GONE: no unreserved storage removal', () => {
    // The old route swept storage and then deleted the row. If the owner
    // submitted the PI in the gap, the delete was refused and a live Submitted
    // PI kept nothing but a broken workbook path. There is no path to that here:
    // every removal is downstream of a claim.
    assert.ok(!route.includes('delete_order_submission'),
      'the single-shot RPC that made that state reachable is gone')
    const sweep = route.indexOf('removeAllObjectsForSubmission(')
    const claimGuard = route.indexOf('if (!claimToken)')
    assert.ok(claimGuard > 0 && claimGuard < sweep,
      'the sweep is unreachable without a claim token in hand')
  })

  test('a failed sweep releases ONLY when nothing destructive was issued', () => {
    // CORRECTED. This used to assert that every failure after the claim gave the
    // record back, which is unsafe: a `.remove()` can delete objects and then
    // lose its response, so an absent confirmation is not proof that nothing
    // went. Releasing there unfreezes a PI whose workbook is already gone.
    //
    // The reservation is now given back only on the provably safe path — a
    // listing that failed before any remove request went out.
    const release = route.indexOf('const release = async ()')
    const finalize = route.indexOf("'finalize_order_submission_deletion'")
    assert.ok(release > 0 && release < finalize)
    assert.ok(route.includes("code: 'STORAGE_CLEANUP_FAILED'"))
    assert.ok(route.includes('if (removal.failed.length > 0)'))

    assert.ok(route.includes('let removalAttempted = false'))
    assert.ok(route.includes('onRemoveAttempt: () => { removalAttempted = true }'),
      'the flag is set BEFORE each request, so a throw cannot hide it')
    for (const match of [...route.matchAll(/await release\(\)/g)]) {
      const line = route.slice(route.lastIndexOf('\n', match.index!) + 1, match.index! + 15)
      assert.ok(/if \(!removalAttempted\)/.test(line),
        `an unguarded release: ${line.trim()}`)
    }
  })

  test('the release never throws over the error it is reporting', () => {
    assert.ok(/const release = async \(\) => \{[\s\S]*?try \{[\s\S]*?\} catch \{/.test(route))
  })

  test('the claim token never reaches the browser', () => {
    const response = route.slice(route.indexOf('return NextResponse.json({\n    ok: true'))
    assert.ok(!response.includes('claimToken'))
    assert.ok(!response.includes('claim_token'))
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(!page.includes('claim'), 'and the page knows nothing about claims')
  })

  test('the paths come from the reservation, never from the request body', () => {
    assert.ok(route.includes('reservation?.storage_paths ?? []'))
    assert.ok(!/body\.(paths|storagePaths)/.test(route))
  })

  test('all three RPCs run as the USER, so ownership and the lock apply to them', () => {
    for (const fn of ['begin_order_submission_deletion',
                      'release_order_submission_deletion',
                      'finalize_order_submission_deletion']) {
      assert.ok(route.includes(`'${fn}'`), `${fn} must be called`)
      assert.ok(!route.includes(`service.rpc('${fn}'`),
        `${fn} as the service role would bypass the actor it re-derives`)
    }
    assert.ok(route.includes('authClient.rpc('))
  })

  test('the service key never leaves the server', () => {
    assert.ok(route.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'))
    assert.ok(!route.includes('NEXT_PUBLIC_SUPABASE_SERVICE'))
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(!page.includes('SERVICE_ROLE'), 'and is nowhere near browser code')
    assert.ok(!page.includes('createServiceClient'))
    const helper = read('src/lib/orders/submissionFilesServer.ts')
    assert.ok(!helper.includes("'use client'"))
  })

  test('no raw database message is ever returned to the browser', () => {
    assert.ok(!/delErr\.message|claimErr\.message|error\.message/.test(route))
    assert.ok(route.includes('classifyDeletionError(delErr)'))
    assert.ok(route.includes('classifyDeletionError(claimErr)'))
  })

  test('the browser never touches the bucket for this', () => {
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(!page.includes('storage.from('))
    assert.ok(page.includes("fetch('/api/orders/submissions/delete'"))
  })
})

describe('the route survives a slow or failed sweep without losing the record', () => {
  const route = read('src/app/api/orders/submissions/delete/route.ts')

  test('THERE IS NO TIMEOUT, because a promise race is not cancellation', () => {
    // The removed version raced a 20s timer and released the reservation on
    // losing — while `.remove()` calls were still in flight against a record
    // about to be unfrozen. storage-js's public remove() accepts no
    // AbortSignal, so those requests could not have been stopped.
    const code = route.split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    assert.ok(!code.includes('withTimeout'))
    assert.ok(!code.includes('Promise.race'))
    assert.ok(!code.includes('setTimeout'))
    assert.ok(!code.includes('STORAGE_CLEANUP_TIMEOUT_MS'))
  })

  test('the reservation is released only from a SETTLED outcome', () => {
    const code = route.split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    const sweep = code.indexOf('await removeAllObjectsForSubmission(')
    assert.ok(sweep > 0)
    for (const match of [...code.matchAll(/await release\(\)/g)]) {
      assert.ok((match.index ?? -1) > sweep,
        'no release may run before the sweep has finished settling')
    }
    assert.ok(!code.includes('finally'),
      'a finally-block release would fire on paths where storage never settled')
  })

  test('a settled sweep failure still releases, which is safe', () => {
    const branch = route.slice(
      route.indexOf('} catch {', route.indexOf('await removeAllObjectsForSubmission(')),
      route.indexOf('timing.sweep = Date.now() - sweepStarted\n  stats'))
    assert.ok(branch.includes('await release()'))
    assert.ok(branch.includes("code: 'STORAGE_CLEANUP_FAILED'"))
  })

  test('an abandoned request leaves the claim frozen for the stale takeover', () => {
    // Nothing releases without first awaiting the sweep, so a killed process
    // never releases at all — which is the safe outcome, not a leak.
    const helper = read('src/lib/orders/submissionFilesServer.ts')
    assert.ok(/stale-claim takeover|stale claim/i.test(helper),
      'and the recovery route is written down beside the decision')
  })

  test('FINALIZATION IS NEVER REACHED after a list or remove failure', () => {
    const finalize = route.indexOf("'finalize_order_submission_deletion'")
    // Every failure path between the claim and finalize returns before it.
    for (const marker of ["code: 'STORAGE_CLEANUP_FAILED', status: 500",
                          "code: 'STORAGE_CLEANUP_FAILED',\n      status: 502"]) {
      const at = route.indexOf(marker)
      assert.ok(at > 0 && at < finalize, `${marker} must return before finalization`)
    }
    assert.ok(route.includes('if (removal.failed.length > 0)'))
  })

  test('a surviving object is never finalized over', () => {
    const guard = route.indexOf('if (removal.failed.length > 0)')
    const finalize = route.indexOf("'finalize_order_submission_deletion'")
    assert.ok(guard > 0 && guard < finalize)
    const branch = route.slice(guard, finalize)
    assert.ok(branch.includes('await release()'))
  })

  test('a successful cleanup finalizes exactly once', () => {
    assert.equal((route.match(/'finalize_order_submission_deletion'/g) ?? []).length, 1,
      'one call site, so there is no path that runs it twice')
  })

  test('a refused finalization NEVER releases: by then the files are gone', () => {
    // CORRECTED alongside the sweep rule above. The sweep reported success
    // before finalization was attempted, so the objects ARE gone; handing the
    // record back would produce a PI that looks healthy and has no workbook.
    const finalizeFail = route.indexOf('if (delErr) {')
    assert.ok(finalizeFail > 0)
    const branch = route.slice(finalizeFail, finalizeFail + 700)
    assert.ok(!branch.includes('await release()'),
      'the reservation stands until another attempt finalizes it')
    assert.ok(branch.includes('THE\n    // RESERVATION IS NOT RELEASED')
      || /RESERVATION IS NOT RELEASED/.test(branch),
      'and the reason is written down where the next reader will find it')
  })

  test('double-click protection is unchanged: the claim is what serializes it', () => {
    // The second request is refused by begin_order_submission_deletion with
    // ORDER_SUBMISSION_DELETION_IN_PROGRESS; the page also guards with a ref.
    assert.ok(route.includes("'begin_order_submission_deletion'"))
    const page = read('src/app/orders/drafts/page.tsx')
    assert.ok(page.includes('if (!entry || deletingRef.current) return'))
    assert.ok(page.includes('deletingRef.current = true'))
  })
})

describe('the deletion reports its timing without reporting anything sensitive', () => {
  const route = read('src/app/api/orders/submissions/delete/route.ts')

  test('every step is measured', () => {
    for (const step of ['timing.claim', 'timing.sweep', 'timing.finalize']) {
      assert.ok(route.includes(step), `${step} must be measured`)
    }
    assert.ok(route.includes('stats.listMs'))
    assert.ok(route.includes('stats.removeMs'))
    assert.ok(route.includes('stats.directories'))
    assert.ok(route.includes('stats.batches'))
    assert.ok(route.includes('objects'))
  })

  test('it goes out as a Server-Timing header', () => {
    assert.ok(route.includes("'Server-Timing': serverTiming()"))
  })

  test('and as ONE structured line, not several noisy ones', () => {
    const logs = route.match(/console\.(log|info|warn|error)\(/g) ?? []
    assert.equal(logs.length, 1, 'one call site, guarded by the report() helper')
    assert.ok(route.includes("console.info('[orders:submission-delete]'"),
      'the repo’s [module:action] convention')
  })

  test('a quiet, ordinary deletion logs nothing at all', () => {
    assert.ok(route.includes("if (note === '' && total < SLOW_DELETION_MS) return"))
  })

  test('NO SECRET, TOKEN OR KEY IS EVER LOGGED', () => {
    const report = route.slice(route.indexOf('const report ='), route.indexOf('const serverTiming ='))
    for (const forbidden of ['claimToken', 'claim_token', 'serviceKey', 'SERVICE_ROLE',
                             'storage_paths', 'removal.found', 'reservation']) {
      assert.ok(!report.includes(forbidden), `${forbidden} must never be logged`)
    }
    const timing = route.slice(route.indexOf('const serverTiming ='), route.indexOf('// Step 4'))
    for (const forbidden of ['claimToken', 'submissionId', 'client_name']) {
      assert.ok(!timing.includes(forbidden), `${forbidden} must not be in the header`)
    }
  })

  test('the header carries counts and durations only', () => {
    const timing = route.slice(route.indexOf('const serverTiming ='), route.indexOf('// Step 4'))
    assert.ok(timing.includes('dirs;desc="directories listed"'))
    assert.ok(timing.includes('objects;desc="objects found"'))
    assert.ok(timing.includes('batches;desc="remove batches"'))
    assert.ok(!/name|path|key/i.test(timing.replace(/desc="[^"]*"/g, '')))
  })
})

describe('the storage sweep takes this submission’s files and nothing else', () => {
  const helper = read('src/lib/orders/submissionFilesServer.ts')

  test('it sweeps the submission’s own prefix, recursively', () => {
    assert.ok(helper.includes('const prefix = `submissions/${submissionId}`'))
    assert.ok(helper.includes('sweepPrefix(service, prefix, LIST_CONCURRENCY)'))
  })

  test('it also takes the paths the record names, so nothing recorded is missed', () => {
    assert.ok(helper.includes('[...new Set([...recorded, ...present])]'))
  })

  test('THE SWEEP IS NO LONGER SERIAL — that was the whole defect', () => {
    // Comments are stripped: the file deliberately QUOTES the old serial line in
    // its own history note, and that quotation is documentation, not code.
    const code = helper.split('\n')
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')

    assert.ok(!code.includes('await walk('),
      'the depth-first inline await turned a shallow tree into a long chain')
    assert.ok(code.includes('mapWithLimit('), 'siblings are listed together')
    assert.ok(code.includes('LIST_CONCURRENCY'))
    // The one Promise.all is over a FIXED-LENGTH worker array, never over the
    // discovered items — which is exactly how an unbounded fan-out gets written.
    assert.equal((code.match(/Promise\.all\(/g) ?? []).length, 1)
    assert.ok(code.includes('await Promise.all(\n    Array.from({ length:'))
  })

  test('but the sweep itself is KEPT — it is what finds abandoned objects', () => {
    assert.ok(helper.includes('sweepPrefix'))
    assert.ok(/Change PI/.test(helper),
      'the reason it exists is written down beside it')
  })

  test('it is breadth-first, so no worker can exit while folders remain', () => {
    assert.ok(helper.includes('let level: string[] = [prefix]'))
    assert.ok(helper.includes('const nextLevel: string[] = []'))
  })

  test('every key it removes is confined to that prefix', () => {
    assert.ok(helper.includes('path.startsWith(`${prefix}/`)'),
      'a key outside this submission is left alone even if the record named it')
  })

  test('NOTHING IT STARTED IS RUNNING WHEN IT RETURNS OR THROWS', () => {
    // The guarantee the reservation depends on: the caller releases the freeze
    // on failure, and a `.remove()` landing after that release would delete the
    // files of a PI that is live again.
    assert.ok(helper.includes('if (failed) return'),
      'a failure stops new work being started')
    assert.ok(helper.includes('await Promise.all('),
      'but every worker is still awaited')
    assert.ok(helper.includes('if (failed) throw firstError'),
      'and the error is rethrown only once they have all stopped')
    assert.ok(!/Promise\.all\(\s*items\.map/.test(helper),
      'never a fail-fast map that abandons its siblings')
  })

  test('a remove batch never rejects, so the map cannot short-circuit it', () => {
    assert.ok(helper.includes('return { removed: [] as string[], errored: batch }'))
    const batch = helper.slice(helper.indexOf('mapWithLimit(batches'))
    assert.ok(batch.includes('try {') && batch.includes('} catch {'),
      'a thrown network error becomes a reported failure, not an abandoned request')
  })

  test('a listing it cannot read is a total failure, not a short list', () => {
    // A truncated sweep would be read as "there is nothing else here", which is
    // precisely the wrong conclusion, and the record would be deleted anyway.
    assert.ok(helper.includes('throw new Error(`Could not list ${prefix}'))
  })

  test('a partial removal is reported as a failure, not as success', () => {
    assert.ok(helper.includes('const failed = found.filter(path =>'))
    assert.ok(helper.includes('!removed.has(path) && (errored.has(path) || present.has(path))'))
  })

  test('but a key that was ALREADY gone is not a failure, so a retry converges', () => {
    // The record always names its workbook, so that key is always submitted. On
    // a second attempt it is already deleted and the API does not report it —
    // counting that as a failure made the retry impossible.
    assert.ok(helper.includes('present.has(path)'),
      'a failure means the sweep just saw it in the bucket')
  })

  test('removal is batched, and the batches are bounded too', () => {
    assert.ok(helper.includes('REMOVE_BATCH'))
    assert.ok(helper.includes('mapWithLimit(batches, REMOVE_CONCURRENCY'))
    assert.ok(helper.includes('found.slice(i, i + REMOVE_BATCH)'))
  })

  test('it is paged, so a large PI is not silently truncated', () => {
    assert.ok(helper.includes('offset += PAGE'))
    assert.ok(helper.includes('if (entries.length < PAGE) break'))
  })
})

// ── The migration ─────────────────────────────────────────────────────────────

describe('the reservation is what makes the two-system sequence safe', () => {
  const source = sql()

  test('the record carries a claim, modelled on the existing processing lease', () => {
    assert.ok(source.includes('deletion_claim_token uuid'))
    assert.ok(source.includes('deletion_claimed_at  timestamptz'))
    assert.ok(source.includes('deletion_claimed_by  uuid references public.users(id)'))
    assert.ok(source.includes('order_submissions_deletion_claim_consistent'),
      'the three columns are all set or all null, as the processing lease is')
  })

  test('there are three doors: begin, release, finalize', () => {
    for (const fn of ['begin_order_submission_deletion',
                      'release_order_submission_deletion',
                      'finalize_order_submission_deletion']) {
      assert.ok(source.includes(`create or replace function public.${fn}(`), `${fn} must exist`)
    }
  })

  test('BEGIN destroys nothing — it authorizes, reserves, and reports', () => {
    const begin = source.slice(
      source.indexOf('create or replace function public.begin_order_submission_deletion'),
      source.indexOf('create or replace function public.release_order_submission_deletion'))
    assert.ok(!/delete\s+from/i.test(begin), 'begin must not delete anything at all')
    assert.ok(begin.includes('for update'), 'and it locks before it judges')
    assert.ok(begin.includes("'claim_token',    v_token"))
    assert.ok(begin.includes("'storage_paths',  to_jsonb(v_paths)"))
  })

  test('the lock is taken BEFORE the status is judged, at the front door', () => {
    const begin = source.slice(
      source.indexOf('create or replace function public.begin_order_submission_deletion'),
      source.indexOf('create or replace function public.release_order_submission_deletion'))
    assert.ok(begin.indexOf('for update') < begin.indexOf('ORDER_SUBMISSION_DELETE_STATUS'))
  })

  test('a RESERVED PI is frozen against every write, by a trigger', () => {
    // A trigger rather than eight restated functions: submit, submit-with-note,
    // submit-with-advance, replace-parse, request-changes, reject and the two
    // exception decisions all end in an UPDATE of this row, and all of them are
    // applied and immutable. One trigger catches every one, plus the next one,
    // plus direct SQL and the service role.
    assert.ok(source.includes('before update on public.order_submissions'))
    assert.ok(source.includes('ORDER_SUBMISSION_DELETION_CLAIMED'))
    for (const fn of ['submit_order_submission', 'replace_order_submission_parse',
                      'request_order_submission_changes', 'reject_order_submission',
                      'approve_pi_advance_exception', 'reject_pi_advance_exception']) {
      assert.ok(!new RegExp(`function public\\.${fn}\\s*\\(`, 'i').test(source),
        `${fn} is applied and must not be restated to add this condition`)
    }
  })

  test('the children are frozen too, so a Change PI cannot go round the parent', () => {
    assert.ok(source.includes('before insert or update or delete on public.order_submission_items'))
    assert.ok(source.includes('before insert or update or delete on public.order_submission_item_images'))
  })

  test('the freeze lets the claim itself move, and NOTHING else', () => {
    // Comparing the whole row minus the claim columns is what stops a release
    // being used to smuggle a status change alongside it.
    assert.ok(source.includes('(to_jsonb(new) - v_claim_columns) = (to_jsonb(old) - v_claim_columns)'))
    assert.ok(source.includes("'deletion_claim_token', 'deletion_claimed_at', 'deletion_claimed_by', 'updated_at'"))
  })

  test('THE CLAIM BLOCKS TRANSITIONS AT ANY AGE — this is the whole invariant', () => {
    // A claim that expired into harmlessness would reopen the gap: the sweep
    // runs long, the claim lapses, somebody submits, and finalize is refused
    // with the files already gone. So the guard never consults the TTL.
    const guard = source.slice(
      source.indexOf('create or replace function public.order_submissions_guard_deletion_claim'),
      source.indexOf('drop trigger if exists order_submissions_guard_deletion_claim'))
    assert.ok(!guard.includes('ttl'), 'the freeze must not weaken with age')
    assert.ok(!guard.includes('now()'), 'the guard asks no question about time')
    // deletion_claimed_at appears once, in the list of columns a release may
    // change — never in a comparison. The guard reads only whether a claim
    // EXISTS, which is what makes finalize unrefusable.
    assert.ok(!/deletion_claimed_at\s*[<>]/.test(guard))
    assert.ok(guard.includes('old.deletion_claim_token is null'),
      'existence, and nothing else, is the question')
  })

  test('the TTL governs takeover and by-hand release, and only those', () => {
    assert.ok(source.includes('create or replace function public.order_submission_deletion_claim_ttl'))
    assert.ok(source.includes("select interval '5 minutes'"))
    const begin = source.slice(
      source.indexOf('create or replace function public.begin_order_submission_deletion'),
      source.indexOf('create or replace function public.release_order_submission_deletion'))
    assert.ok(begin.includes('order_submission_deletion_claim_ttl()'),
      'a stale claim may be taken over by a fresh attempt')
    assert.ok(begin.includes('ORDER_SUBMISSION_DELETION_IN_PROGRESS'),
      'and a live one is a neutral "already happening"')
  })

  test('a crashed request never blocks a PI forever', () => {
    const release = source.slice(
      source.indexOf('create or replace function public.release_order_submission_deletion'),
      source.indexOf('create or replace function public.finalize_order_submission_deletion'))
    assert.ok(release.includes("'claim_active'"), 'a LIVE claim is not snatched away')
    assert.ok(release.includes('v_stale'), 'but a stale one can be released without the token')
    assert.ok(release.includes('order_submission_deletable_by'),
      'and only by somebody who could have deleted it anyway')
  })

  test('release RETURNS rather than raises, because it runs on a failure path', () => {
    const release = source.slice(
      source.indexOf('create or replace function public.release_order_submission_deletion'),
      source.indexOf('create or replace function public.finalize_order_submission_deletion'))
    assert.ok(!/raise exception/i.test(release),
      'a release that threw would replace the real error with a cleanup error')
    assert.ok(release.includes("'released', false"))
  })

  test('the claim token is random, and is matched against THIS row', () => {
    assert.ok(source.includes('v_token := gen_random_uuid()'), 'pgcrypto CSPRNG, not guessable')
    const finalize = source.slice(
      source.indexOf('create or replace function public.finalize_order_submission_deletion'))
    assert.ok(finalize.includes('v_sub.deletion_claim_token <> p_claim_token'))
    assert.ok(finalize.includes('v_sub.deletion_claim_token is null'),
      'a released or taken-over claim matches nothing')
    assert.ok(finalize.includes('ORDER_SUBMISSION_DELETION_CLAIM_INVALID'))
  })

  test('a leaked token is not authority', () => {
    const finalize = source.slice(
      source.indexOf('create or replace function public.finalize_order_submission_deletion'))
    assert.ok(finalize.includes('order_submission_deletable_by(p_submission_id, v_actor)'),
      'somebody who could not delete the record cannot finalize it either')
  })

  test('finalize re-checks the status anyway, though nothing could have moved it', () => {
    const finalize = source.slice(
      source.indexOf('create or replace function public.finalize_order_submission_deletion'))
    assert.ok(finalize.includes('order_submission_deletable_statuses()'))
    assert.ok(finalize.includes('for update'))
  })
})

describe('the browser is told the truth about each outcome', () => {
  test('an in-flight deletion is neutral, not an error', () => {
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETION_IN_PROGRESS: this PI is already being deleted')),
      'IN_PROGRESS')
    const failure = describeDeletionFailure('IN_PROGRESS')
    assert.ok(/already being deleted/i.test(failure.message))
    assert.ok(!/error|fail|problem|wrong/i.test(failure.message),
      'a second click on a deletion that is already running is not a fault')
  })

  test('a guard refusal reads as the same in-flight state', () => {
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion')),
      'IN_PROGRESS')
  })

  test('an interrupted deletion says so, and invites a retry', () => {
    assert.equal(classifyDeletionError(
      new Error('ORDER_SUBMISSION_DELETION_CLAIM_INVALID: not valid for this PI')), 'CLAIM_INVALID')
    const failure = describeDeletionFailure('CLAIM_INVALID')
    assert.ok(/did not complete/i.test(failure.message))
    assert.ok(/try again/i.test(failure.message))
  })

  test('a storage failure still says plainly that NOTHING was deleted', () => {
    // The reservation is released and every record survives, so this is true in
    // the strongest sense: the PI is exactly as it was.
    assert.ok(/nothing was deleted/i.test(describeDeletionFailure('STORAGE_CLEANUP_FAILED').message))
    assert.equal(describeDeletionFailure('STORAGE_CLEANUP_FAILED').refresh, false)
  })

  test('there is NO message about files being lost from a surviving PI', () => {
    // That state is unreachable by construction. A message for it would be a
    // message nobody can ever see, describing a bug that does not exist.
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'STATUS_CHANGED', 'NOT_FOUND',
                        'IN_PROGRESS', 'CLAIM_INVALID', 'STORAGE_CLEANUP_FAILED',
                        'DELETE_FAILED'] as const) {
      const { message } = describeDeletionFailure(code)
      assert.ok(!/files (were|have been) (removed|deleted|lost)/i.test(message), code)
    }
  })
})

describe('the migration is one new forward file, in the right place', () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()

  test('it exists, and it is named for what it does', () => {
    assert.ok(files.includes(MIGRATION))
  })

  test('it sorts AFTER the applied Phase B migration', () => {
    assert.ok(files.includes(APPLIED_PHASE_B))
    assert.ok(MIGRATION > APPLIED_PHASE_B,
      'an applied migration is immutable; a change is a later file, never an edit')
    assert.equal(files[files.indexOf(APPLIED_PHASE_B) + 1], MIGRATION,
      'and nothing was slipped in between')
  })

  test('anything that lands after it belongs to this same feature', () => {
    // IT WAS the last migration when it was written, and demanding it stay so
    // would make this suite fail every time the company shipped anything else —
    // which says nothing about whether deletion is still safe. THE PROPERTY THAT
    // ACTUALLY MATTERS is narrower: a later file may exist, and Phase C is one,
    // but it must be part of the PI submission feature rather than unrelated
    // work reaching into these tables. The same rule submissionSchema.test.ts
    // already applies to the migration that created them.
    for (const file of files.filter(f => f > MIGRATION)) {
      assert.ok(/order_submission/i.test(file),
        `${file} lands after the deletion migration but is not part of this feature`)
    }
  })

  test('no two migrations share a version prefix', () => {
    const versions = files.map(f => f.split('_')[0])
    const seen = new Set<string>()
    for (const version of versions) {
      assert.ok(!seen.has(version), `duplicate migration version ${version}`)
      seen.add(version)
    }
  })

  test('Item B itself added exactly ONE migration', () => {
    // Between the applied Phase B migration and this one, inclusive, there is
    // exactly one new file. Later phases add their own and are not counted here.
    const added = files.filter(f => f > APPLIED_PHASE_B && f <= MIGRATION)
    assert.deepEqual(added, [MIGRATION])
  })
})

describe('the migration is additive, and touches nothing that is applied', () => {
  const source = sql()

  test('it drops no table, column or constraint', () => {
    assert.ok(!/drop\s+table/i.test(source))
    assert.ok(!/drop\s+column/i.test(source))
    assert.ok(!/drop\s+constraint/i.test(source))
    assert.ok(!/alter\s+table[\s\S]{0,80}?drop/i.test(source))
  })

  test('every ALTER TABLE only ADDS', () => {
    // The reservation needed three columns and one consistency CHECK. Nothing
    // existing is widened, narrowed or removed.
    const alters = source.match(/alter\s+table[\s\S]*?;/gi) ?? []
    assert.ok(alters.length > 0)
    for (const statement of alters) {
      assert.ok(/add\s+(column|constraint)/i.test(statement),
        `only additive ALTERs are allowed, got: ${statement.slice(0, 80)}`)
    }
  })

  test('the new columns are the reservation, and are added if-not-exists', () => {
    for (const column of ['deletion_claim_token', 'deletion_claimed_at', 'deletion_claimed_by']) {
      assert.ok(source.includes(`add column if not exists ${column}`),
        `${column} must be added idempotently`)
    }
  })

  test('it redefines none of the applied workflow functions', () => {
    for (const fn of ['submit_order_submission', 'submit_order_submission_with_advance',
                      'approve_pi_advance_exception', 'reject_pi_advance_exception',
                      'request_order_submission_changes', 'reject_order_submission',
                      'order_submissions_enforce_status_transition',
                      'order_submissions_guard_advance_exception',
                      'log_order_submission_activity']) {
      assert.ok(!new RegExp(`function public\\.${fn}\\s*\\(`, 'i').test(source),
        `${fn} belongs to an applied migration and must not be restated`)
    }
  })

  test('the UI fix is NOT in here — Item A was TypeScript', () => {
    assert.ok(!/advance_exception_percent\s*=/.test(source))
    assert.ok(!/advance_condition\s*=/.test(source))
  })
})

describe('the migration enforces the same rule the screen draws', () => {
  const source = sql()

  test('the eligible statuses are an allow-list, and they are the same three', () => {
    assert.ok(source.includes("select array['draft', 'needs_changes', 'rejected']::text[]"))
    for (const status of DELETABLE_SUBMISSION_STATUSES) {
      assert.ok(source.includes(`'${status}'`), `${status} must be in the SQL list too`)
    }
  })

  test('the status is judged with the allow-list, never with a not-in list', () => {
    assert.ok(source.includes('= any (public.order_submission_deletable_statuses())'))
    assert.ok(!/status\s+not\s+in\s*\(/i.test(source), 'a deny-list would not fail closed')
  })

  test('ownership is created_by OR submitted_by, as the screen reads it', () => {
    assert.ok(source.includes('v_sub.created_by = p_actor_id or v_sub.submitted_by = p_actor_id'))
  })

  test('admin is the project’s established check, not a permission', () => {
    assert.ok(/role = 'admin'/.test(source))
    assert.ok(!/actor_has_module_permission/.test(source),
      'no Orders permission may reach a PI deletion')
    assert.ok(!/resolve_permission/.test(source))
  })

  test('the row is locked BEFORE its status is judged', () => {
    const lock = source.indexOf('for update');
    const statusCheck = source.indexOf('ORDER_SUBMISSION_DELETE_STATUS')
    assert.ok(lock > 0 && lock < statusCheck,
      'a PI submitted between the read and the click must be refused')
  })

  test('every refusal has a stable, distinct code', () => {
    for (const marker of ['ORDER_SUBMISSION_DELETE_MISSING',
                          'ORDER_SUBMISSION_DELETE_STATUS',
                          'ORDER_SUBMISSION_DELETE_DENIED']) {
      assert.ok(source.includes(marker), `${marker} must be raised`)
      assert.equal(classifyDeletionError(new Error(`${marker}: …`)) === 'DELETE_FAILED', false,
        `${marker} must be mapped in the browser`)
    }
  })

  test('the children are removed explicitly, not left to a cascade', () => {
    for (const table of ['order_submission_item_images', 'order_submission_items',
                         'order_submission_activity', 'order_submissions']) {
      assert.ok(source.includes(`delete from public.${table}`), `${table} must be named`)
    }
  })

  test('and nothing shared is named at all', () => {
    for (const table of ['users', 'clients', 'products', 'orders', 'notifications',
                         'finance_payment_requests', 'order_requests']) {
      assert.ok(!new RegExp(`delete from public\\.${table}\\b`).test(source),
        `${table} must never be deleted by this`)
    }
  })

  test('a direct DELETE is refused for every caller, service role included', () => {
    assert.ok(source.includes('before delete on public.order_submissions'))
    assert.ok(source.includes('before delete on public.order_submission_activity'))
    assert.ok(source.includes('a PI submission is deleted only through finalize_order_submission_deletion()'))
  })

  test('the purge marker names ONE submission, and is cleared afterwards', () => {
    assert.ok(source.includes("v_marker = p_submission_id::text"))
    assert.ok(source.includes("set_config('boe.order_submission_purge_id', '', true)"))
  })

  test('it deletes no storage object — it reports the keys instead', () => {
    assert.ok(!/delete from storage\.objects/i.test(source),
      'removing the row without the bytes is the one unrecoverable outcome')
    assert.ok(source.includes("'storage_paths',  to_jsonb(v_paths)"))
    assert.ok(source.includes("'storage_prefix', 'submissions/' || p_submission_id::text"))
  })

  test('no client role may execute the internals', () => {
    for (const internal of ['order_submission_purge_in_progress(uuid)',
                            'order_submissions_guard_deletion_claim()',
                            'order_submission_child_guard_deletion_claim()',
                            'order_submissions_guard_delete()',
                            'order_submission_activity_guard_delete()']) {
      assert.ok(new RegExp(`revoke execute on function public\\.${internal.replace(/[()]/g, '\\$&')}[\\s\\n]*from public, anon, authenticated, service_role;`)
        .test(source), `${internal} must be internal`)
    }
  })

  test('the three deletion RPCs are the only doors, and they are open to a caller', () => {
    for (const fn of ['begin_order_submission_deletion(uuid)',
                      'release_order_submission_deletion(uuid, uuid)',
                      'finalize_order_submission_deletion(uuid, uuid)']) {
      assert.ok(source.includes(`grant  execute on function public.${fn} to authenticated;`))
      assert.ok(source.includes(`revoke all     on function public.${fn} from public, anon;`))
    }
    assert.ok(!source.includes('function public.delete_order_submission('),
      'the single-shot RPC is gone — it is what made the bad state reachable')
  })

  test('it introduces no approval, no numbering and no payment', () => {
    // Comments and COMMENT ON prose are stripped: both legitimately DESCRIBE the
    // boundary ("never once approved", "implies no payment"), and what is being
    // asserted is that no STATEMENT crosses it.
    const code = source
      .replace(/--.*$/gm, '')
      .replace(/comment on [\s\S]*?;\n/gi, '')

    assert.ok(!/'approved'/.test(code), 'no statement mentions the approved state')
    assert.ok(!/order_id\s*=/.test(code), 'no Order is ever linked')
    assert.ok(!/payment/i.test(code), 'no payment table is read or written')
    assert.ok(!/display_number|order_number/.test(code), 'no number is allocated')
    assert.ok(!/insert into/i.test(code), 'deletion writes nothing anywhere')
  })
})
