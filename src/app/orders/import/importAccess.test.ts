/**
 * The contract of the New Order PI import screen.
 *
 * Two kinds of assertion, both offline:
 *
 *   1. BEHAVIOURAL — what deriveOrdersCapabilities answers for the people this
 *      route has to admit and turn away. A viewer is not a creator, and module
 *      entry is not authority to raise an order.
 *   2. SOURCE-SHAPE — what src/app/orders/import/page.tsx actually does, read
 *      off the file. These exist because the promises Phase 3A makes are
 *      promises about ABSENCE — nothing saved, nothing uploaded, nothing
 *      logged, no order number invented — and absence is exactly what a
 *      reviewer stops noticing after the third read. They fail loudly if a
 *      later edit quietly adds a fetch, a bucket write, a console call, or a
 *      role literal in place of the permission check.
 *
 * Reads repository files only. No DB, no network, no browser.
 *
 * Run:
 *   npx tsx --test src/app/orders/import/importAccess.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import type { EffectivePermission } from '@/lib/permissions/types'

const ROOT = process.cwd()

/**
 * Source with its comments removed.
 *
 * The absence assertions below search for API names, and a file that DOCUMENTS
 * why it never touches localStorage would otherwise fail for saying so. What is
 * being asserted is what the code does, so the prose is stripped first: block
 * comments (including the `{/* … *​/}` JSX form) anywhere, and whole-line `//`
 * comments. Keep trailing comments free of API names and this stays honest.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const read = (p: string) => stripComments(readFileSync(join(ROOT, p), 'utf8'))

const IMPORT_PAGE = 'src/app/orders/import/page.tsx'
const ORDERS_DASHBOARD = 'src/app/orders/page.tsx'
const ORDERS_LAYOUT = 'src/app/orders/layout.tsx'
const ORDERS_NAV = 'src/components/layout/OrdersLayout.tsx'
const PREVIEW_VIEW = 'src/lib/pi/previewView.ts'
const SAVE_FLOW = 'src/lib/orders/saveDraftFlow.ts'
/** The Phase A action rules: who may submit, replace, return or reject. */
const WORKFLOW = 'src/lib/orders/submissionWorkflow.ts'
/**
 * The preview furniture — cards, thumbnails, the customization cell, the image
 * viewer and the commercial summary — moved here when the saved-draft screen
 * arrived, because both screens render the same document and must render it the
 * same way. The assertions that used to read them off the import page now read
 * them off the component, and the page keeps the assertions about what the PAGE
 * still decides: which URL bag exists, when it is revoked, and what is keyed by
 * what.
 */
const PI_PARTS = 'src/components/orders/piPreview.tsx'
const DRAFT_DETAIL_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const DRAFTS_VIEW = 'src/lib/orders/draftsView.ts'

const perms = (allowedActions: string[]): EffectivePermission[] =>
  allowedActions.map(actionKey => ({ actionKey, allowed: true, source: 'role' }))

// ── Who may open /orders/import ───────────────────────────────────────────────

describe('orders.create decides access to the PI import route', () => {
  test('a member with view + create may open it', () => {
    assert.equal(deriveOrdersCapabilities('member', perms(['view', 'create'])).canCreateOrder, true)
  })

  test('a viewer with only module entry may NOT', () => {
    const caps = deriveOrdersCapabilities('member', perms(['view']))
    assert.equal(caps.canAccessOrdersModule, true, 'they can still open Order Management')
    assert.equal(caps.canCreateOrder, false, 'but not raise an order')
  })

  test('create without module entry is not access — the parent gate still applies', () => {
    assert.equal(deriveOrdersCapabilities('member', perms(['create'])).canCreateOrder, false)
  })

  test('an employee with no Orders permissions at all may NOT', () => {
    assert.equal(deriveOrdersCapabilities('member', []).canCreateOrder, false)
    assert.equal(deriveOrdersCapabilities(null, []).canCreateOrder, false)
    assert.equal(deriveOrdersCapabilities(undefined, []).canCreateOrder, false)
  })

  test('a denied grant does not admit, even when the row exists', () => {
    const denied: EffectivePermission[] = [
      { actionKey: 'view', allowed: true, source: 'role' },
      { actionKey: 'create', allowed: false, source: 'employee_override' },
    ]
    assert.equal(deriveOrdersCapabilities('member', denied).canCreateOrder, false)
  })

  test('an admin may', () => {
    assert.equal(deriveOrdersCapabilities('admin', []).canCreateOrder, true)
  })

  test('neither approval authority nor assignee eligibility stands in for create', () => {
    for (const action of ['approve', 'approve_order', 'manage', 'can_be_order_assignee', 'view_all']) {
      const caps = deriveOrdersCapabilities('member', perms(['view', action]))
      assert.equal(caps.canCreateOrder, false, `orders.${action} must not imply create`)
    }
  })
})

// ── The route enforces it itself ──────────────────────────────────────────────

describe('the route gate, not just the button', () => {
  test('the page resolves orders permissions for the signed-in user', () => {
    const source = read(IMPORT_PAGE)
    assert.ok(source.includes("getEffectivePermissions(supabase, session.user.id, 'orders')"),
      'the route must resolve the orders module for the signed-in user')
    assert.ok(source.includes('deriveOrdersCapabilities'),
      'the route must go through the capability helper')
    assert.ok(source.includes('caps.canCreateOrder'),
      'the route must gate on create, not on module entry')
  })

  test('a denied caller stays in Orders and never reaches another module', () => {
    // THE DEFECT THIS PINS. Denial used to `router.replace('/coming-soon')`,
    // which is a hard-coded ATTENDANCE placeholder ("Attendance Module — Coming
    // Soon"). Someone opening a PI upload link without orders.create was told
    // that a module they had not asked about is under development, lost the
    // Orders context, and got no way back to the records they can work with.
    const source = read(IMPORT_PAGE)
    assert.ok(!source.includes("router.replace('/coming-soon')"),
      'denial must not send an Orders user to another module’s placeholder')
    assert.ok(!source.includes('/coming-soon'), 'not by any route')
    assert.ok(source.includes("setAccess('denied')"), 'the state is resolved, not navigated')
  })

  test('the denial is the Orders access-denied screen', () => {
    const source = read(IMPORT_PAGE)
    assert.ok(source.includes("if (access === 'denied') {"), 'it renders rather than redirects')
    assert.ok(source.includes('PI upload is not enabled for your account'))
    assert.ok(source.includes('<OrdersLayout'), 'inside the Orders shell, with its sidebar')
    // A way onward that every Orders user can actually open: reading drafts
    // needs module entry, not create.
    assert.ok(source.includes("router.push('/orders/drafts')"))
    assert.ok(source.includes('Go to PI Drafts'))
  })

  test('the denial names no permission internals', () => {
    const source = read(IMPORT_PAGE)
    const denied = source.slice(source.indexOf("if (access === 'denied') {"))
      .slice(0, source.slice(source.indexOf("if (access === 'denied') {")).indexOf('\n  }\n'))
    assert.ok(!/orders\.create|resolve_permission|RLS|policy/i.test(denied),
      'an employee cannot act on a permission key and it is not theirs to grant')
  })

  test('checking still renders nothing, so no frame of the importer leaks', () => {
    const source = read(IMPORT_PAGE)
    // REVISED (usability pass): the Orders shell with a skeleton — no importer,
    // no file control and no action — rather than the full-screen spinner.
    assert.ok(source.includes("if (access === 'checking') return <OrdersRouteFallback />"),
      'children must not render while the permission is still being resolved')
  })

  test('an authorized creator still reaches the importer, and a reload works', () => {
    const source = read(IMPORT_PAGE)
    // The gate is the resolved permission, not a navigation, so a direct reload
    // lands in exactly the same state rather than bouncing.
    assert.ok(source.includes("setAccess('allowed')"))
    // The only navigation left on this screen is the sign-in redirect for a
    // caller with no session at all. Nothing about a PERMISSION navigates, so
    // there is no loop to enter and a direct reload lands in the same state.
    // Two call sites, one destination: the no-session guard and sign-out.
    const redirects = [...new Set([...source.matchAll(/router\.replace\('([^']+)'\)/g)].map(m => m[1]))]
    assert.deepEqual(redirects, ['/login'])
  })

  test('a failed profile read denies rather than admits', () => {
    assert.ok(read(IMPORT_PAGE).includes('if (!me || !caps.canCreateOrder)'),
      'an unidentified caller must be refused')
  })

  test('authority is never taken from a role literal on this screen', () => {
    const source = read(IMPORT_PAGE)
    assert.ok(!/role\s*===\s*['"]admin['"]/.test(source),
      'the route must not re-derive admin from users.role')
    assert.ok(!/role\s*===\s*['"]manager['"]/.test(source))
  })

  test('the module parent gate is still in front of it', () => {
    assert.ok(read(ORDERS_LAYOUT).includes("hasPermission(supabase, session.user.id, 'orders', 'view')"),
      'the Orders layout must still require module entry')
  })
})

// ── The entry point ───────────────────────────────────────────────────────────

describe('the Upload PI entry point', () => {
  test('is gated on the same capability the route enforces', () => {
    const source = read(ORDERS_DASHBOARD)
    assert.ok(source.includes('ordersCaps.canCreateOrder'), 'the button must ask the capability helper')
    assert.ok(source.includes('NEW_ORDER_ACTION.href'), 'and lead to the import route')
    assert.ok(read('src/lib/orders/orderDashboard.ts').includes("href: UPLOAD_PI_PATH"))
    assert.ok(read('src/lib/orders/orderDashboard.ts').includes("export const UPLOAD_PI_PATH = '/orders/import'"))
    assert.ok(source.includes('NO_ORDERS_CAPABILITIES'),
      'capabilities must start empty so the button cannot flash before they resolve')
  })

  test('it is called Upload PI, not New Order', () => {
    // What the control does is upload one document. An Order comes into
    // existence at APPROVAL, with a number, and a button promising one here
    // would describe a step this action cannot reach — which is exactly what the
    // retired Order Request path used to promise.
    assert.ok(read('src/lib/orders/orderDashboard.ts').includes("label: 'Upload PI'"))
  })

  test('PI Drafts is reachable from the Orders sidebar', () => {
    const nav = read(ORDERS_NAV)
    assert.ok(nav.includes("label: 'PI Drafts'"), 'the destination must exist in the nav')
    assert.ok(nav.includes("path: '/orders/drafts'"))
    assert.ok(nav.includes('FileText'), 'with a document icon')
  })

  test('the retired Order Request entry is gone from the navigation', () => {
    const nav = read(ORDERS_NAV)
    const items = nav.slice(nav.indexOf('const navItems'), nav.indexOf('return ('))
    assert.equal(items.includes("path: '/orders/requests'"), false,
      'the nav must not offer a workflow the database refuses')
    assert.ok(items.includes("path: '/orders/all'"), 'Confirmed Orders must remain')
  })
})

// ── The promises of absence ───────────────────────────────────────────────────

describe('nothing is persisted, uploaded or logged', () => {
  const source = read(IMPORT_PAGE)

  test('the workbook is never stored on the device', () => {
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      assert.ok(!source.includes(api), `${api} must not appear on the PI import screen`)
    }
  })

  test('the workbook leaves this tab ONLY as a private storage upload', () => {
    // Phase 3B uploads the workbook the employee chose to save. It goes
    // straight to the private order-files bucket — never as a request body,
    // and never to anything but Supabase.
    assert.ok(!source.includes('FormData'), 'a 10 MiB multipart body would be refused by the platform')
    assert.ok(!source.includes('XMLHttpRequest'))
    assert.ok(!source.includes('base64'))
    assert.ok(source.includes(".from('order-files')"), 'the one destination is the private bucket')

    const hosts = source.match(/https?:\/\/[^'"`\s]+/g) ?? []
    assert.deepEqual(hosts, [], 'no absolute URL — nothing is sent to a third party')
  })

  test('the only fetch is the project’s own trusted endpoint', () => {
    const fetches = [...source.matchAll(/fetch\(\s*'([^']+)'/g)].map(m => m[1])
    assert.deepEqual(fetches, ['/api/orders/import/process-draft'])
  })

  test('the only database writes are the draft row and its own storage upload', () => {
    for (const call of ['.insert(', '.upsert(', '.update(', '.delete(']) {
      assert.ok(!source.includes(call), `${call} must not appear — this screen writes no table directly`)
    }
    const rpcs = [...source.matchAll(/\.rpc\(\s*'([^']+)'/g)].map(m => m[1])
    // TWO RPCS since 20261219000000: the one that creates an empty draft, and
    // the one that removes it again when the save failed and nothing was ever
    // saved to it. Neither writes a figure; the server writes every one.
    assert.deepEqual([...rpcs].sort(), ['create_order_submission', 'discard_unsaved_order_submission'],
      'the draft is created and, after a failed save, discarded; every figure is written by the server')
  })

  test('the tables read are the access check and the record being replaced', () => {
    // Three `.from()` targets exist: the signed-in profile, the submission a
    // Change PI link names, and the storage bucket. Asserting the set is what
    // keeps a fourth from appearing unnoticed.
    const targets = [...new Set([...source.matchAll(/\.from\(\s*'([^']+)'/g)].map(m => m[1]))].sort()
    assert.deepEqual(targets, ['order-files', 'order_submissions', 'users'])
    assert.ok(source.includes(".from('users')"), 'the signed-in user profile')
    assert.ok(source.includes(".from('order_submissions')"),
      'and the record a replacement attaches to, read under the caller’s own RLS')
  })

  test('no parsed workbook content reaches a log or telemetry sink', () => {
    for (const sink of ['console.log', 'console.error', 'console.warn', 'console.info', 'console.debug']) {
      assert.ok(!source.includes(sink), `${sink} must not appear — a PI carries client and price data`)
    }
  })

  test('the parse failure path does not read the thrown value', () => {
    assert.ok(source.includes('} catch {'),
      'the catch must bind nothing, so an error carrying workbook content cannot be shown or logged')
  })
})

describe('object URLs are released', () => {
  const source = read(IMPORT_PAGE)

  test('the page revokes on unmount', () => {
    assert.ok(source.includes('mountedRef.current = false') && source.includes('releaseImages()'),
      'leaving the screen must release every blob')
  })

  test('a parse that finishes after the screen has gone away frees its own URLs', () => {
    assert.ok(source.includes('images.revokeAll()'),
      'an in-flight parse must revoke on the spot when the unmount cleanup has already run')
    assert.ok(source.includes('if (!mountedRef.current) return'),
      'and must not set state on a screen that is gone')
  })

  test('the page revokes before a replacement file is read', () => {
    assert.ok(source.includes('releaseImages()'), 'replacing the PI must release the previous blobs')
    const releases = source.match(/releaseImages\(\)/g) ?? []
    assert.ok(releases.length >= 2,
      'both the rejected-file path and the accepted-file path must release first')
  })

  test('revocation is idempotent, so unmount after replacement is safe', () => {
    assert.ok(read(PREVIEW_VIEW).includes('if (revoked) return'),
      'createPiImageUrls must guard against a double revoke')
  })
})

describe('replacing the PI', () => {
  const source = read(IMPORT_PAGE)

  test('the file input outlives the drop zone', () => {
    // The drop zone is swapped out for the preview once a PI has been read. An
    // input mounted inside it would unmount with it, leaving "Change PI"
    // clicking a null ref — so the input belongs in the page body, after the
    // layout opens, not in the `uploader` block declared above the return.
    const layoutAt = source.indexOf('<OrdersLayout')
    const inputAt = source.indexOf('<input')
    assert.ok(layoutAt > -1 && inputAt > -1)
    assert.ok(inputAt > layoutAt,
      'the file input must be rendered unconditionally inside the layout, not inside the drop zone')
  })

  test('selecting the same file twice still re-reads it', () => {
    assert.ok(source.includes("e.target.value = ''"),
      'the input must be cleared, or choosing the same file again fires no change event')
  })

  test('another file cannot be chosen while one is being read', () => {
    assert.ok(source.includes('if (!file || parsing) return'), 'the accept path must refuse mid-parse')
    assert.ok(source.includes('if (parsing) return'), 'the picker and the drop target must refuse too')
    assert.ok(source.includes('disabled={parsing}'), 'and the controls must show it')
  })
})

// ── Save Draft ────────────────────────────────────────────────────────────────

describe('the Save Draft action', () => {
  const source = read(IMPORT_PAGE)

  test('is gated through the shared helper, not an inline condition', () => {
    assert.ok(source.includes('canSaveDraft({'))
    assert.ok(source.includes('blockingCount: preview.groups.blocking.length'))
    assert.ok(source.includes('saving,'))
  })

  test('only appears in the ready state, so a blocked PI has no save control', () => {
    const readyAt = source.indexOf('preview.groups.readyToSubmit &&')
    // The rendered button, not the import at the top of the file.
    const buttonAt = source.indexOf("{saving ? 'Saving…' : SAVE_BUTTON_LABEL}")
    assert.ok(readyAt > -1, 'the ready block exists')
    assert.ok(buttonAt > readyAt, 'the save button is rendered inside it')
  })

  test('a second click cannot start a second save', () => {
    assert.ok(source.includes('if (savingRef.current) return'),
      'a ref, because state updates are async and two clicks share a tick')
    assert.ok(source.includes('savingRef.current = true'))
    assert.ok(source.includes('savingRef.current = false'))
  })

  test('it re-checks the blocking count at the moment of the click', () => {
    assert.ok(source.includes("if (stage.kind !== 'ready' || stage.preview.groups.blocking.length > 0) return"))
  })

  test('all four progress stages are shown', () => {
    for (const stage of ['creating', 'uploading', 'verifying', 'saving']) {
      assert.ok(source.includes(`setSaveStage('${stage}')`), `stage ${stage}`)
    }
    assert.ok(source.includes('saveStageLabel(saveStage!)'))
    assert.ok(source.includes('saveStageIndex(saveStage!)'))
  })

  test('the workbook goes straight to storage, not through an API route', () => {
    assert.ok(source.includes(".from('order-files')"))
    assert.ok(source.includes('.upload(path, workbookFileRef.current'))
    assert.ok(!source.includes('FormData'), 'a 10 MiB body would be refused by the platform')
  })

  test('the draft row is created through the authenticated RPC', () => {
    assert.ok(source.includes("supabase.rpc('create_order_submission'"))
    assert.ok(!source.includes('replace_order_submission_parse'),
      'the privileged RPC is unreachable from here')
  })

  test('an upload failure keeps the preview and offers a retry', () => {
    assert.ok(source.includes("describeSaveFailure('UPLOAD_FAILED')"))
    // The stage returns to null in `finally`, so the button becomes live again.
    assert.ok(source.includes('setSaveStage(null)'))
  })

  test('the server response overrides the browser’s assumptions', () => {
    assert.ok(source.includes('summariseSaveResult(body, draft.submissionId)'),
      'the success panel is built from the RESPONSE, not from the preview')
    assert.ok(source.includes('saveFailure.serverRejectedDocument'))
  })

  test('a saved draft never claims an order number', () => {
    assert.ok(source.includes('saveSuccess.note'))
    assert.ok(read(SAVE_FLOW).includes('No official order number has been assigned'))
  })

  test('a successful save takes the employee to the record it created', () => {
    // THE DEFECT THIS PINS. A real PI was saved in production and then could
    // not be found: the success card said "Draft saved" and offered a way back
    // to the Orders dashboard, and the only pointer to the new record lived in
    // the memory of the tab that made it.
    // REPLACE since the usability pass, so Back from the new draft does not
    // land on an empty upload form.
    assert.ok(source.includes('router.replace(draftSavedHref(success.submissionId))'),
      'the save must navigate to the saved draft')
    assert.ok(source.includes('const success = summariseSaveResult(body, draft.submissionId)'),
      'and the id it navigates to is the SERVER’S, read off the response')
    // Scoped to the save flow. The denied screen legitimately offers the Orders
    // dashboard as a way onward; what must never happen is a SUCCESSFUL SAVE
    // ending there, which is how a real draft became unreachable.
    const saveStart = source.indexOf('const saveDraft = useCallback')
    const saveFlow = source.slice(saveStart, source.indexOf('const acceptFile = useCallback', saveStart))
    assert.ok(saveFlow.length > 0 && saveFlow.includes('setSaveStage'), 'the slice is the save flow')
    assert.ok(!saveFlow.includes("router.push('/orders')"),
      'a dead end back to the dashboard is what left the draft unreachable')
  })

  test('the route it navigates to is built in one place', () => {
    const flow = read(DRAFTS_VIEW)
    assert.ok(flow.includes('return `/orders/drafts/${submissionId}`'))
    assert.ok(flow.includes("return `${draftDetailHref(submissionId)}?saved=1`"))
    assert.ok(!source.includes('/orders/drafts/${'),
      'the page must not hand-build the path beside the helper that owns it')
  })

  test('a fallback link survives a navigation that does not happen', () => {
    assert.ok(source.includes('Open saved draft'))
    assert.ok(source.includes("router.push('/orders/drafts')"))
  })

  test('the chosen file is held in memory only', () => {
    assert.ok(source.includes('workbookFileRef'))
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      assert.ok(!source.includes(api), `${api} must not appear on the PI import screen`)
    }
  })

  test('replacing the PI clears the previous outcome and the held file', () => {
    assert.ok(source.includes('workbookFileRef.current = null'))
    assert.ok(source.includes('setSaveSuccess(null)'))
    assert.ok(source.includes('draftRef.current.workbookPath = null'),
      'a new workbook is uploaded, and the draft row is reused')
  })

  test('Change PI never discards the draft, so no second submission is created', () => {
    // The ONE place the draft is let go is after the server has discarded it
    // (a failed save, 20261219000000) — never on a changed file.
    assert.equal((source.match(/draftRef\.current = null/g) ?? []).length, 1)
    const discardAt = source.indexOf('const discardDraft = useCallback')
    const resetAt = source.indexOf('draftRef.current = null')
    assert.ok(discardAt > -1 && resetAt > discardAt && resetAt < source.indexOf('const discardOnLeave'),
      'a changed file is a new reading of the SAME editable draft')
    assert.ok(source.includes('if (gone && draftRef.current === draft) {'),
      'and only once the server says nothing is left')
    // The only place a draft is created is guarded on there being none.
    const creations = source.match(/create_order_submission/g) ?? []
    assert.equal(creations.length, 1)
    assert.ok(source.includes('if (!draftRef.current) {'))
  })

  test('a retry after a successful upload does not upload again', () => {
    const uploadAt = source.indexOf('.upload(path, workbookFileRef.current')
    const recordAt = source.indexOf('draft.workbookPath = path')
    const failAt = source.indexOf("describeSaveFailure('UPLOAD_FAILED')")
    assert.ok(source.includes('if (!draft.workbookPath) {'), 'the upload step is skipped when the key is known')
    assert.ok(recordAt > uploadAt && recordAt > failAt,
      'the key is recorded only on the success branch, so a failed upload retries properly')
  })

  test('a retry after a process failure reuses the stored workbook', () => {
    // Only the outcome is cleared on retry; the attempt state is not.
    assert.ok(source.includes('setSaveFailure(null)'))
    const saveAt = source.indexOf('const saveDraft = useCallback')
    const body = source.slice(saveAt, source.indexOf('}, [stage, supabase])', saveAt))
    assert.ok(!body.includes('draftRef.current = null'), 'attempt state survives a failure')
  })

  test('attempt state lives in memory only', () => {
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      assert.ok(!source.includes(api), `${api} must not hold attempt state`)
    }
    assert.ok(source.includes('useRef<{ submissionId: string; workbookPath: string | null } | null>(null)'))
  })

  test('this screen still submits nothing for approval', () => {
    // Submission is a decision taken on the RECORD, in front of the stored copy
    // the reviewer will see — not on a preview of a file that has not been
    // saved yet. So the upload screen has no submit control and calls no submit
    // RPC, even now that submission exists.
    assert.ok(!source.includes('submit_order_submission'))
    assert.ok(!/Submit for Approval/i.test(source))
  })
})

// ── Change PI on an existing record ───────────────────────────────────────────

describe('replacing the PI on a record that already exists', () => {
  const source = read(IMPORT_PAGE)

  test('the target comes from the URL and is validated before it is used', () => {
    assert.ok(source.includes('readChangePiTarget(searchParams.get(CHANGE_PI_PARAM))'),
      'anything that is not a uuid never reaches the database')
    assert.ok(read(WORKFLOW).includes("export const CHANGE_PI_PARAM = 'submissionId'"),
      'the parameter name is defined once, beside the helper that builds the link')
  })

  test('the record is re-read under the caller’s own policies', () => {
    assert.ok(source.includes(".from('order_submissions')"))
    assert.ok(source.includes(".eq('id', target)"))
    assert.ok(!source.includes('SERVICE_ROLE'), 'no privileged client on a screen')
  })

  test('only the OWNER of an editable record may replace its PI', () => {
    assert.ok(source.includes('record.created_by === session.user.id || record.submitted_by === session.user.id'),
      'the same ownership pair the storage write policy uses')
    assert.ok(source.includes('canReplaceSubmissionPi(record.status)'),
      'and the same two editable states')
    assert.ok(!/role === 'admin'/.test(source),
      'no admin branch: can_write_order_submission_file has none either, so one here would fail at the upload')
  })

  test('a refused target says the same thing for all three reasons', () => {
    assert.ok(source.includes("setReplaceTarget({ kind: 'unavailable' })"))
    assert.ok(!/not\s+allowed|no\s+permission|forbidden/i.test(source),
      'the screen must not confirm that somebody else’s submission exists')
  })

  test('a refused target can never fall through to creating a second record', () => {
    assert.ok(source.includes("if (replaceTarget.kind === 'checking' || replaceTarget.kind === 'unavailable') return"),
      'the save handler refuses outright')
    assert.ok(source.includes('disabled={replaceBlocked || !canSaveDraft({'),
      'and the button is disabled, so it is not merely a silent no-op')
  })

  test('an adopted target is the draft the save reuses', () => {
    assert.ok(source.includes('draftRef.current = { submissionId: record.id, workbookPath: null }'),
      'the existing submission is in hand before the first save')
    assert.ok(source.includes('if (!draftRef.current) {'),
      'so create_order_submission is skipped — no second submission for a replacement')
    const creations = source.match(/create_order_submission/g) ?? []
    assert.equal(creations.length, 1, 'and there is still exactly one place a draft is created')
  })

  test('the replacement reuses every existing safeguard, adding none of its own', () => {
    // The lease, the trusted re-parse, the image integrity checks, the rollback
    // and the cleanup all live behind this one endpoint. A replacement takes the
    // identical path; what differs is only which submission row it lands on.
    const fetches = [...source.matchAll(/fetch\(\s*'([^']+)'/g)].map(m => m[1])
    assert.deepEqual(fetches, ['/api/orders/import/process-draft'])
    assert.ok(!source.includes('replace_order_submission_parse'),
      'the privileged RPC stays unreachable from the browser')
  })

  test('it says which record is being replaced, and offers the way back', () => {
    assert.ok(source.includes('Replacing the PI on an existing record'))
    assert.ok(source.includes('draftDetailHref(replaceTarget.submissionId)'),
      'the way back is to the same record, built by the shared helper')
  })
})

describe('no order number is shown or invented', () => {
  const source = read(IMPORT_PAGE)

  test('the number printed on the workbook is never rendered', () => {
    assert.ok(!source.includes('sourceOrderNumber'),
      'B20 must not be read by the screen at all — showing it with a disclaimer still read as an order number')
  })

  test('nothing predicts or formats a future official number', () => {
    assert.ok(!/display_number/.test(source), 'no order numbering on this screen')
    assert.ok(!/BOE\//.test(source), 'no order-number template on this screen')
    assert.ok(!/order\s*(number|no\.?|#)/i.test(source), 'and nothing is labelled as one')
  })

  test('the action saves a DRAFT and does not submit it', () => {
    // Phase 3B replaces the inert "Continue to Submission" with a real save.
    // What stays inert is approval: nothing here calls submit_order_submission.
    assert.ok(!source.includes('Continue to Submission'))
    assert.ok(!source.includes('submit_order_submission'))
    assert.ok(source.includes('SAVE_BUTTON_LABEL'))
    assert.ok(read(SAVE_FLOW).includes("SAVE_BUTTON_LABEL = 'Save Draft'"))
  })
})

describe('the preview is read-only', () => {
  const source = read(IMPORT_PAGE)

  test('no editable field is offered for commercial or product data', () => {
    // The one input on the screen is the file picker.
    const inputs = source.match(/<input/g) ?? []
    assert.equal(inputs.length, 1, 'the only input is the file picker')
    assert.ok(source.includes('type="file"'))
    assert.ok(!source.includes('<textarea'), 'no free-text editing of workbook content')
    assert.ok(!source.includes('<select'), 'nothing about the PI is chosen on this screen')
  })

  test('workbook text is never rendered as markup', () => {
    assert.ok(!source.includes('dangerouslySetInnerHTML'),
      'a PI is untrusted input; it is rendered as text')
  })
})

// ── One replace control ───────────────────────────────────────────────────────

describe('the PI replacement control', () => {
  const source = read(IMPORT_PAGE)

  test('there is exactly one "Change PI"', () => {
    const occurrences = source.match(/Change PI/g) ?? []
    assert.equal(occurrences.length, 1, 'one replace control, in the page header')
  })

  test('the older duplicates are gone', () => {
    assert.ok(!source.includes('Select another PI'),
      '"Select another PI" was a second name for the same action')
  })

  test('it lives in the layout header, not inside the preview cards', () => {
    const actionsAt = source.indexOf('actions={')
    const changeAt = source.indexOf('Change PI')
    const previewAt = source.indexOf('const previewBlock')
    assert.ok(changeAt > actionsAt && changeAt > previewAt,
      'the control belongs to the header slot')
  })

  test('the drop zone keeps its own primary action for the empty state', () => {
    assert.ok(source.includes('Select Excel'), 'the first-time action stays on the drop zone')
  })

  test('this screen hides the layout refresh control', () => {
    assert.ok(source.includes('showRefresh={false}'),
      'nothing here comes from the server, so refresh would clear and reload nothing')
  })
})

describe('the shared Orders layout is unchanged in what it renders by default', () => {
  const layout = read(ORDERS_NAV)

  test('refresh is opt-out, so every other Orders page is untouched', () => {
    assert.ok(layout.includes('showRefresh = true'),
      'the prop must default to the previous behaviour')
  })

  test('Switch to Finance belongs to the shared layout, not to this screen', () => {
    assert.ok(layout.includes("<ModuleSwitchButton target=\"finance\""),
      'the control is the shared layout’s, and stays there')
    assert.ok(!read(IMPORT_PAGE).includes('ModuleSwitchButton'),
      'the PI screen neither adds nor removes it')
  })
})

// ── The full-image viewer ─────────────────────────────────────────────────────

describe('product thumbnails', () => {
  const source = read(PI_PARTS)

  test('the whole picture is shown, never cropped', () => {
    assert.ok(source.includes("objectFit: 'contain'"),
      'a tall wardrobe must not be cropped to its middle')
    assert.ok(!source.includes("objectFit: 'cover'"),
      'cover hides part of the product being ordered')
  })

  test('the thumbnail box keeps a fixed size so rows stay aligned', () => {
    assert.ok(source.includes('width: size, height: size'))
  })

  test('a missing picture keeps the same box rather than collapsing the row', () => {
    // The placeholder spreads the same `box`, so no row shortens and no
    // neighbouring product's photograph slides up into the gap.
    assert.ok(source.includes('...box,'))
    assert.ok(source.includes('No image'))
  })

  test('the thumbnail is a real button with an accessible name', () => {
    assert.ok(source.includes('aria-label={label}'))
    assert.ok(source.includes("cursor: 'zoom-in'"), 'and looks clickable')
  })

  test('the accessible name identifies the product', () => {
    assert.ok(read(PREVIEW_VIEW).includes('View full image for '))
  })
})

describe('the image viewer', () => {
  const source = read(PI_PARTS)
  const page = read(IMPORT_PAGE)

  test('uses dialog semantics', () => {
    assert.ok(source.includes('role="dialog"'))
    assert.ok(source.includes('aria-modal="true"'))
    assert.ok(source.includes('aria-labelledby="pi-image-viewer-title"'))
  })

  test('shows the full picture uncropped, within the viewport budget', () => {
    // THE REGRESSION THIS PINS. The picture used to be capped with
    // `maxHeight: '100%'` inside a flex stage of indeterminate height, which
    // computes to `none` — so a portrait photograph was laid out at its natural
    // size and the panel's own overflow clipped the bottom of it. The cap is
    // now against the VIEWPORT, which is definite everywhere.
    assert.ok(source.includes('PI_VIEWER_IMAGE_MAX_HEIGHT'))
    assert.ok(source.includes('PI_VIEWER_IMAGE_MAX_WIDTH'))
    assert.ok(/PI_VIEWER_IMAGE_MAX_HEIGHT\s*=\s*`max\(160px, calc\(100dvh/.test(source),
      'the height budget is viewport-based, and dvh so a phone toolbar cannot cover the last strip')
    assert.ok(/PI_VIEWER_IMAGE_MAX_WIDTH\s*=\s*`min\(/.test(source) && source.includes('calc(100vw -'),
      'and so is the width budget')
    assert.ok(!/maxHeight:\s*'100%'\s*,?\s*\n?\s*width:/.test(source))
    assert.ok(source.includes("width: 'auto', height: 'auto'"),
      'a picture smaller than the budget is centred at its own size, never stretched')
  })

  test('the picture is fitted, never cropped, in the viewer as in the table', () => {
    assert.ok(source.includes("objectFit: 'contain'"))
    assert.ok(!source.includes("objectFit: 'cover'"),
      'cover would hide the top and bottom of a tall wardrobe')
  })

  test('the panel itself cannot exceed the viewport', () => {
    assert.ok(source.includes("height: '100dvh'"), 'the backdrop is the small viewport')
    assert.ok(source.includes("maxHeight: '100%'"), 'and the panel is capped inside it')
    assert.ok(source.includes("overflow: 'hidden'"))
  })

  test('the page behind does not scroll while it is open', () => {
    assert.ok(source.includes('useScrollLock(true)'),
      'through the shared reference-counted lock, not a private overflow swap')
  })

  test('the step controls are always rendered, so nothing hides behind them', () => {
    // Always present rather than conditional: the height budget above only
    // adds up if the footer is always there, and a control that comes and goes
    // is one people stop reaching for.
    assert.ok(!source.includes('{(nav.canPrev || nav.canNext) && ('),
      'the footer must not be conditional on there being somewhere to step')
    assert.ok(source.includes("'Previous product image'"))
    assert.ok(source.includes("'Next product image'"))
    assert.ok(source.includes('aria-label="Close image viewer"'))
  })

  test('closes on Escape, on the backdrop, and on the Close button', () => {
    assert.ok(source.includes("e.key === 'Escape'"))
    assert.ok(source.includes('aria-label="Close image viewer"'))
    assert.ok(source.includes('onClick={onClose}'))
  })

  test('a click on the dialog itself does not reach the backdrop', () => {
    assert.ok(source.includes('onClick={e => e.stopPropagation()}'),
      'clicking the picture or a button must not close the viewer')
  })

  test('steps between images with the arrow keys and with buttons', () => {
    assert.ok(source.includes("e.key === 'ArrowLeft'"))
    assert.ok(source.includes("e.key === 'ArrowRight'"))
    // The two step buttons are built by one helper, which applies the name it
    // is given as aria-label — so the names appear as its arguments.
    assert.ok(source.includes("'Previous product image'"))
    assert.ok(source.includes("'Next product image'"))
    assert.ok(source.includes('aria-label={label}'), 'and the helper wires it to aria-label')
  })

  test('navigation at the ends is disabled rather than wrapping', () => {
    assert.ok(source.includes('nav.canPrev') && source.includes('nav.canNext'))
    assert.ok(source.includes('disabled={!enabled}'))
  })

  test('focus moves in on open and returns to the thumbnail on close', () => {
    assert.ok(source.includes('closeRef.current?.focus()'), 'focus moves into the dialog')
    // Focus RETURN belongs to whichever screen owns the thumbnails, so it is
    // asserted on both of them rather than on the shared dialog.
    for (const file of [IMPORT_PAGE, DRAFT_DETAIL_PAGE]) {
      assert.ok(read(file).includes('thumbnailRefs.current.get(key)?.focus()'),
        `${file} must hand focus back to the thumbnail that opened the viewer`)
    }
  })

  test('it reuses the existing object URL and creates no blob of its own', () => {
    assert.ok(source.includes('src={item.url}'), 'the viewer shows the URL the table already holds')
    assert.ok(!source.includes('createObjectURL'), 'the viewer creates nothing')
    assert.ok(!page.includes('createObjectURL'), 'no second blob for the same bytes')
    const bagCalls = page.match(/createPiImageUrls\(/g) ?? []
    assert.equal(bagCalls.length, 1, 'URLs are created once, when the PI is read')
  })

  test('replacing the PI closes the viewer BEFORE anything is revoked', () => {
    const closeAt = page.indexOf('setViewerIndex(null)')
    const releaseAt = page.indexOf('releaseImages()')
    assert.ok(closeAt > -1 && releaseAt > -1)
    assert.ok(closeAt < releaseAt,
      'a dialog must never be left holding a revoked blob')
  })

  test('no modal or carousel dependency was added', () => {
    for (const dep of ['react-modal', 'lightbox', 'swiper', 'react-image', 'headlessui']) {
      assert.ok(!source.toLowerCase().includes(dep), `${dep} must not be introduced`)
      assert.ok(!page.toLowerCase().includes(dep), `${dep} must not be introduced`)
    }
  })
})

describe('image coverage is shown near the products', () => {
  const source = read(IMPORT_PAGE)

  test('the indicator is rendered from the helper, not counted inline', () => {
    assert.ok(source.includes('describeImageCoverage'))
    assert.ok(source.includes('preview.coverage.label'))
  })

  test('an incomplete count is styled as a problem', () => {
    assert.ok(source.includes('preview.coverage.complete'))
    assert.ok(source.includes('colors.redTint'))
  })

  test('customization images get their own, separate count', () => {
    assert.ok(source.includes('describeCustomizationImageCount'))
    assert.ok(source.includes('preview.customizationCount.label'))
  })

  test('the customization count is hidden when there are none', () => {
    assert.ok(source.includes('preview.customizationCount.count > 0'),
      'zero optional images is not a fact worth a badge')
  })

  test('the two counts are never combined', () => {
    // "4 of 12" would report eight missing files that were never meant to
    // exist. The label comes from the helper, which builds a plain total.
    assert.ok(read(PREVIEW_VIEW).includes('customization image${count === 1'),
      'the customization label is a plain total')
  })
})

describe('the commercial summary renders worded zeroes distinctly', () => {
  const source = read(PI_PARTS)

  test('the screen branches on the value kind, not on a boolean', () => {
    assert.ok(source.includes("row.kind === 'text'"))
    assert.ok(source.includes("row.kind === 'amount'"))
    assert.ok(!source.includes('notApplicable'),
      'the component must not hard-code either worded zero; the helper supplies the words')
  })

  test('it is compact and right-aligned on a desktop, full width on a phone', () => {
    // Across a 1920px monitor each row was a label at one edge and a figure at
    // the other, which is not merely sparse: pairing the two costs an eye
    // movement per row. Capped and pushed right, it sits under the money column
    // of the table above it. The cap does nothing below its own width, so the
    // phone case needs no media query and no JavaScript.
    assert.ok(source.includes('PI_COMMERCIAL_MAX_WIDTH_PX = 780'))
    assert.ok(source.includes("width: '100%'"))
    assert.ok(source.includes('maxWidth: `${PI_COMMERCIAL_MAX_WIDTH_PX}px`'))
    assert.ok(source.includes("marginLeft: 'auto'"))
  })

  test('every commercial row still comes from the one builder', () => {
    // The width changed; the figures did not. The component renders the rows it
    // is handed and computes nothing — no subtotal, no GST, no grand total, and
    // no advance.
    // The callback gained a body when the detail page's Grand Total needed a
    // class; what it still does is render one row per row it was handed.
    //
    // `ledger` is `rows` with the advance taken out — the advance is rendered
    // below the total as its own callout rather than as a tenth addend — so
    // every row handed in is still rendered exactly once, by key, and nothing
    // is dropped, merged or recomputed on the way.
    assert.ok(/ledger\.map\(row => \{/.test(source))
    assert.ok(source.includes("const ledger = rows.filter(row => row.emphasis !== 'advance')"))
    assert.ok(source.includes("const advance = rows.find(row => row.emphasis === 'advance') ?? null"))
    assert.ok(source.includes('key={row.key}'))
    assert.ok(source.includes('{advance.value}'), 'the advance figure is the builder’s own string')
    assert.ok(source.includes('{advance.label}'))
    assert.ok(source.includes('{advance.note}'))
    for (const arithmetic of ['* 0.4', 'PI_ADVANCE_PERCENT', 'Math.round', 'reduce(']) {
      assert.ok(!source.includes(arithmetic),
        `${arithmetic} must not appear — this component renders figures, it does not derive them`)
    }
  })

  test('the grand total and the required advance stay emphasised', () => {
    assert.ok(source.includes("row.emphasis === 'total'"))
    assert.ok(source.includes("row.emphasis === 'advance'"))
    assert.ok(source.includes('row.emphasis ? 700 : '))
  })

  test('both PI screens render it through the same component and builder', () => {
    // The DETAIL page filters ONE row out of what the builder returns — the
    // required-advance line, which its own top-of-page snapshot now owns and
    // would contradict on any PI with an approved exception. The filter is the
    // page's, by key, and the builder is untouched: the preview still gets every
    // row, including that one, which is the only advance IT ever states.
    assert.ok(read(IMPORT_PAGE).includes('<PiCommercialSummary rows={buildCommercialRows('),
      'the preview renders the builder’s rows unchanged')
    const detail = read(DRAFT_DETAIL_PAGE)
    // The detail page builds those rows ONCE into `commercialRows` — the top
    // summary repeats two of them beside the payment and must not be able to
    // disagree with the breakdown — so the filter and the builder are asserted
    // where they are composed rather than inline in the JSX.
    assert.ok(detail.includes('const commercialRows = commercialBreakdownRows(buildCommercialRows('),
      'the detail page runs the same builder through the same named filter')
    // The detail page's breakdown is a card of its own now — the preview's
    // component is untouched — and it is handed a SELECTION of exactly those
    // rows: nothing rebuilt, nothing recomputed.
    assert.ok(detail.includes('const breakdown = buildBreakdownView(commercialRows)'),
      'the breakdown selects from exactly those rows')
    assert.ok(detail.includes('<PiCommercialBreakdown'),
      'the breakdown card is still the thing that renders it')
    assert.ok(detail.includes('view={breakdown}'),
      'and renders that selection')
    // WHAT IT GAINED, AND WHAT IT DID NOT. The card also states who provides
    // the fabric and what the prices cover (20261225000000). Both are
    // SENTENCES about the figures, passed in beside them — neither is a
    // commercial row, so buildCommercialRows is unchanged and the preview
    // still renders exactly what it always did.
    assert.ok(detail.includes('fabricResponsibility={submission.fabric_responsibility'),
      'the fabric answer is passed, not derived')
    assert.ok(detail.includes('commercialTerms={submission.commercial_terms_note'),
      'and so are the terms')
    assert.ok(detail.includes('summaryCommercialFigures(commercialRows)'),
      'and the summary card picks its two figures out of the same array')
  })

  test('the two screens share the reading of the figures; the variant is chrome only', () => {
    // WHAT THE VARIANT IS FOR, NOW. It was once the seam that kept the detail
    // page's typography off the upload preview. Three of those differences were
    // never about which screen you were on — digits that line up, a rule before
    // tax, and a Grand Total you can find — so they apply to both and the
    // detail card's markup is unchanged by that (it already had all three).
    //
    // What the flag still decides is CARD CHROME: the width cap and the right
    // alignment under the product table, the warm border and shallow shadow,
    // the cream header, and the quieter ledger the preview alone takes.
    const source = read(PI_PARTS)
    assert.ok(source.includes("variant = 'preview'"), 'the default is the upload screen')
    assert.ok(source.includes("const detail = variant === 'detail'"))
    assert.ok(!read(IMPORT_PAGE).includes('variant='),
      'and the preview asks for nothing')
    for (const shared of ["fontVariantNumeric: 'tabular-nums'",
                          "row.groupStart ? `1px solid ${colors.borderSoft}`",
                          "className={grandTotal ? 'pi-commercial-grand-total' : undefined}"]) {
      assert.ok(source.includes(shared), `${shared} must reach both screens`)
    }
    for (const chrome of ['detail ? DETAIL_CARD_STYLE : undefined',
                          'detail ? DETAIL_HEADER_STYLE : undefined',
                          'const quiet = !detail && !row.emphasis']) {
      assert.ok(source.includes(chrome), `${chrome} must stay behind the variant`)
    }
  })

  test('"Included" and "Not applicable" come from the one formatter', () => {
    const view = read(PREVIEW_VIEW)
    assert.ok(view.includes("NOT_APPLICABLE_TEXT = 'Not applicable'"))
    assert.ok(view.includes("INCLUDED_TEXT = 'Included'"))
    assert.ok(view.includes("value.zeroMeaning === 'included'"))
    assert.ok(view.includes("value.zeroMeaning === 'notApplicable'"))
  })

  test('an included charge is never rendered as an absent one', () => {
    const view = read(PREVIEW_VIEW)
    const included = view.indexOf('INCLUDED_TEXT')
    const notApplicable = view.indexOf('NOT_APPLICABLE_TEXT')
    assert.ok(included > -1 && notApplicable > -1 && included !== notApplicable,
      'they are two distinct strings, for two distinct commercial facts')
  })
})

// ── Customization images ──────────────────────────────────────────────────────

describe('the customization column', () => {
  const source = read(PI_PARTS)
  const page = read(IMPORT_PAGE)

  test('text comes first, then the pictures', () => {
    assert.ok(page.includes('CustomizationCell'))
    assert.ok(source.includes('{hasText && ('))
    assert.ok(source.includes('{hasImages && ('))
  })

  test('"No customization" appears only when there is neither text nor images', () => {
    assert.ok(source.includes('const marked = hasText || hasImages'),
      'one predicate decides both the wording and the accent')
    assert.ok(source.includes('const body = !marked'),
      'a row plainly showing four pictures must not also say it has none')
    assert.ok(source.includes('formatCustomization(text)'),
      'and the wording comes from the one tested helper, not a second copy of the rule')
  })

  test('several thumbnails wrap instead of stretching the row', () => {
    assert.ok(source.includes("flexWrap: 'wrap'"))
    // Sized from the shared table, and still smaller than the product's own
    // photograph so a row of four changes does not outweigh the product.
    assert.ok(source.includes('PI_THUMBNAIL_SIZE.customizationCompact'))
    assert.ok(source.includes('PI_THUMBNAIL_SIZE.customization'))
    const customization = Number(/\n  customization: (\d+)/.exec(source)?.[1])
    const representative = Number(/representative: (\d+)/.exec(source)?.[1])
    assert.ok(customization < representative,
      'a picture of a change must not compete with the product itself')
  })

  test('the representative image keeps its own column and its own lookup', () => {
    assert.ok(page.includes('representativeThumbnail'))
    assert.ok(page.includes('images.representativeByRow.get(row)'))
    assert.ok(page.includes('images.customizationByRow.get(row)'))
  })

  test('a customization thumbnail is addressed by its own key, not by row', () => {
    // A row now owns several pictures; a row-keyed lookup would always resolve
    // to the representative one.
    assert.ok(page.includes('customization-${row}-${index}'))
    assert.ok(page.includes('item.key === key'))
  })

  test('every customization image gets its own thumbnail, even when they share bytes', () => {
    assert.ok(page.includes('.map((url, index) =>'),
      'the map is over IMAGES, so two changes sharing one photograph render twice')
  })
})

// ── The customization accent ──────────────────────────────────────────────────

describe('customization is marked in red, and only where there is one', () => {
  const source = read(PI_PARTS)

  test('the accent is spent on the heading, the words and the pictures', () => {
    assert.ok(source.includes('PI_CUSTOMIZATION_TINT = colors.redTint'),
      'the column heading takes a light tint from the existing token')
    assert.ok(source.includes("PI_CUSTOMIZATION_HEADER_RED = '#B3222E'"))
    assert.ok(source.includes("PI_CUSTOMIZATION_TEXT_RED = '#9B1C25'"))
    assert.ok(source.includes("CUSTOMIZATION_BORDER = 'rgba(217,79,79,0.45)'"),
      'and a customization thumbnail is bordered, not filled')
  })

  test('a row with no customization gets no red at all', () => {
    // The quiet case is the one that keeps the loud case meaningful. The empty
    // state renders the muted grey italic it always did.
    assert.ok(source.includes("color: colors.muted, fontStyle: 'italic'"))
    assert.ok(source.includes('color: marked ? PI_CUSTOMIZATION_HEADER_RED : colors.muted'),
      'the stacked label is red only when there is something to point at')
    assert.ok(source.includes("background: marked ? PI_CUSTOMIZATION_TINT : 'transparent'"),
      'and only the customization HEADING is tinted')
  })

  test('the cells below the heading are never filled red', () => {
    // A tinted heading marks a column; a tinted column shouts over the product
    // name and its picture, which must stay the dominant thing on the line.
    const tintUses = source.match(/PI_CUSTOMIZATION_TINT/g) ?? []
    assert.equal(tintUses.length, 2, 'the tint is declared once and used once, on the <th>')
    for (const page of [IMPORT_PAGE, DRAFT_DETAIL_PAGE]) {
      const s = read(page)
      assert.ok(!s.includes('redTint') || !/<td[^>]*redTint/.test(s),
        `${page} must not fill a customization cell`)
    }
  })

  test('customization TEXT is the heavier of the two reds', () => {
    assert.ok(source.includes('color: PI_CUSTOMIZATION_TEXT_RED, fontWeight: 600'),
      'the instruction itself is semibold and the darkest red on the row')
  })

  test('the two reds clear AA against what they sit on', () => {
    // Measured, not chosen by eye. BOE red #DC1F2E on the tint is 4.50:1 —
    // exactly on the line for 10px uppercase text — so both values here are
    // darker members of the same family.
    const luminance = (hex: string) => {
      const channels = [1, 3, 5]
        .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }
    const contrast = (a: string, b: string) => {
      const [x, y] = [luminance(a), luminance(b)]
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
    }
    // rgba(217,79,79,0.07) composited over white.
    const tintOverWhite = '#FCF3F3'

    assert.ok(contrast('#B3222E', tintOverWhite) >= 4.5,
      'the tinted heading is legible on its own background')
    assert.ok(contrast('#9B1C25', '#FFFFFF') >= 4.5,
      'and the instruction is legible on the row')
  })

  test('a marked thumbnail keeps its own hue on hover', () => {
    assert.ok(source.includes('e.currentTarget.style.borderColor = marked ? PI_CUSTOMIZATION_HEADER_RED : colors.blue'),
      'turning it blue would un-mark the one picture that was marked')
    assert.ok(source.includes('e.currentTarget.style.borderColor = restingBorder'),
      'and it returns to its own resting border, not to the neutral one')
  })

  test('a customization thumbnail is still a button that opens the viewer', () => {
    // The accent is a border. It must not have cost the click.
    assert.ok(source.includes('accent="customization"'))
    assert.ok(source.includes('onClick={onOpen}'))
    assert.ok(source.includes("cursor: 'zoom-in'"))
    assert.ok(source.includes('aria-label={label}'))
  })

  test('the representative image is left neutral', () => {
    assert.ok(source.includes("accent = 'neutral'"), 'neutral is the default')
    for (const page of [IMPORT_PAGE, DRAFT_DETAIL_PAGE]) {
      assert.ok(!/representativeThumbnail\([^)]*\)[^>]*accent=/.test(read(page)),
        `${page} must not accent the product's own photograph`)
    }
  })
})

describe('both PI tables share one head', () => {
  const source = read(PI_PARTS)

  test('the columns are defined once', () => {
    assert.ok(source.includes('PI_PRODUCT_COLUMNS'))
    assert.ok(source.includes("{ key: 'customization', label: 'Customization', align: 'left', accent: 'customization' }"))
  })

  test('every column the tables had is still there, in order', () => {
    const labels = [...source.matchAll(/\{ key: '[^']+',\s+label: '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(labels,
      ['#', 'Image', 'Product', 'Qty', 'Dimensions', 'Material', 'Customization', 'Cost / piece', 'Line total'])
  })

  test('money stays right-aligned', () => {
    assert.ok(source.includes("{ key: 'cost',          label: 'Cost / piece', align: 'right' }"))
    assert.ok(source.includes("{ key: 'lineTotal',     label: 'Line total',   align: 'right' }"))
  })

  test('neither screen hand-rolls its own heading row any more', () => {
    for (const page of [IMPORT_PAGE, DRAFT_DETAIL_PAGE]) {
      const s = read(page)
      assert.ok(s.includes('<PiProductTableHead />'), `${page} must render the shared head`)
      assert.ok(!s.includes("'Cost / piece'"),
        `${page} must not keep a second copy of the column list`)
    }
  })
})

describe('the viewer distinguishes the two roles', () => {
  const source = read(PI_PARTS)
  const page = read(IMPORT_PAGE)

  test('the role is stated on every frame', () => {
    assert.ok(source.includes('{item.roleLabel}'))
    assert.ok(source.includes("item.role === 'customization'"), 'and styled distinctly')
  })

  test('the position within a product’s changes comes from the helper', () => {
    assert.ok(read(PREVIEW_VIEW).includes('Customization image ${index + 1} of ${customization.length}'))
  })

  test('the alt text carries the role too', () => {
    assert.ok(source.includes('alt={`${item.roleLabel}'))
  })

  test('the dialog is keyed by the picture, not by the product row', () => {
    for (const file of [IMPORT_PAGE, DRAFT_DETAIL_PAGE]) {
      assert.ok(read(file).includes('key={viewerItem.key}'),
        'a row owns several pictures; keying by row would leave the dialog stale')
    }
  })

  test('focus return is per picture', () => {
    assert.ok(page.includes('thumbnailRefs.current.get(key)?.focus()'))
  })

  test('still one URL bag, created once, for both roles', () => {
    const bagCalls = page.match(/createPiImageUrls\(/g) ?? []
    assert.equal(bagCalls.length, 1)
    assert.ok(!page.includes('createObjectURL'))
  })
})

// ── The Order information block ───────────────────────────────────────────────
//
// WHAT THE SCREEN OPENS WITH, and where each of the eight facts comes from.
// buildOrderInformationRows decides the labels and the formatting, and
// previewView.test.ts holds it to them; what is asserted HERE is the wiring —
// that the page hands the builder the right three inputs, from the right three
// places, and renders the result in the three groups it was asked for.

describe('the Order information block', () => {
  const source = read(IMPORT_PAGE)

  test('the eight fields come from the one builder, not from the page', () => {
    assert.ok(source.includes('buildOrderInformationRows({'),
      'the labels and the em-dash rule live in the view layer, with their tests')
    assert.ok(!source.includes('buildHeaderRows'),
      'the old seven-field block, with its duplicated Bill to and Ship to, is gone')
    for (const removed of ['label="Bill to"', 'label="Ship to"', 'label="PI created"',
                           'label="Created by"']) {
      assert.ok(!source.includes(removed), `${removed} must not be re-added to the page`)
    }
  })

  test('Product value is the commercial summary’s own figure, not a second sum', () => {
    assert.ok(source.includes('grossProductAmount: preview.data.commercial.grossProductAmount'),
      'the parsed cell, passed straight through')
    // The page states the figure; it never derives one. Any arithmetic here
    // would be a second path to a number the client has already been sent.
    const wiring = source.slice(source.indexOf('buildOrderInformationRows({'),
                                source.indexOf('const byKey = (key: string)'))
    for (const arithmetic of ['+', '*', 'Math.', 'reduce(', 'toFixed(']) {
      assert.ok(!wiring.includes(arithmetic), `${arithmetic} must not appear in the wiring`)
    }
  })

  test('Uploaded by is the signed-in application user', () => {
    assert.ok(source.includes('upload: { by: profile?.full_name ?? null, at: preview.readAt }'),
      'the profile this screen already loaded — never a workbook cell, never an id')
    // G21 is the SALESPERSON and is a different field on the same block, so the
    // two can never collapse into one another.
    const view = read(PREVIEW_VIEW)
    assert.ok(view.includes("label: 'Salesperson',    value: orDash(header.createdBy)"))
    assert.ok(view.includes("label: 'Uploaded by',    value: orDash(upload.by)"))
  })

  test('Upload date is read once, when the parse succeeds — never during render', () => {
    // A clock called while rendering ticks on every re-render: opening the
    // image viewer, resizing past the mobile breakpoint or starting a save
    // would each move a timestamp that is supposed to record one moment.
    const clocks = source.match(/new Date\(\)/g) ?? []
    assert.equal(clocks.length, 1, 'exactly one clock reading on this screen')
    assert.ok(source.includes('readAt: formatSavedAt(new Date().toISOString())'),
      'and it is stored on the preview, through the shared formatter')

    // It is inside the parse-success branch: after the parse returned ok, in
    // the same object literal as the products and images it belongs with.
    const readWorkbook = source.slice(source.indexOf('const readWorkbook = useCallback'),
                                      source.indexOf('const parsing = stage.kind'))
    assert.ok(readWorkbook.includes('readAt:'), 'the reading happens in readWorkbook')
    assert.ok(readWorkbook.indexOf('if (!result.ok)') < readWorkbook.indexOf('readAt:'),
      'a workbook that failed to parse never records an upload moment')
    assert.ok(readWorkbook.indexOf("kind: 'ready',") < readWorkbook.indexOf('readAt:'),
      'and it is part of the preview that parse produced')

    // NOTHING BELOW RENDER MAY DERIVE IT. previewBlock reads preview.readAt and
    // never a clock, so re-rendering the block cannot change what it says.
    const previewBlock = source.slice(source.indexOf('const previewBlock = preview && ('))
    assert.ok(!previewBlock.includes('new Date('),
      'the rendered block takes the stored moment and never asks the clock again')
    assert.ok(previewBlock.includes('at: preview.readAt'))
  })

  test('it is not persisted, and the saved record keeps the server’s own timestamp', () => {
    // The caption is a caption. If it ever reached the save it would become a
    // browser-supplied timestamp on a business record.
    const saveDraft = source.slice(source.indexOf('const saveDraft = useCallback'),
                                   source.indexOf('const acceptFile = useCallback'))
    assert.ok(!saveDraft.includes('readAt'), 'the save never sends it')
  })

  test('the three groups are rendered, and the dates are a group of their own', () => {
    for (const group of ["group(['client', 'productValue', 'location'], 3)",
                         "group(['confirmed', 'due'], 3)",
                         "group(['salesperson', 'uploadedBy', 'uploadedAt'], 3)"]) {
      assert.ok(source.includes(group), `${group} must be the grouping the screen renders`)
    }
    assert.ok(source.includes("? '1fr 1fr'"),
      'and every group collapses to two columns on a phone')
  })
})

// ── The product line reads code-first ─────────────────────────────────────────

describe('the product code outranks the product name', () => {
  const source = read(IMPORT_PAGE)

  /** The nearest style object above a rendered value, as numbers. */
  function styleOf(marker: string, occurrence: number, label: string) {
    let at = -1
    for (let i = 0; i <= occurrence; i++) at = source.indexOf(marker, at + 1)
    assert.notEqual(at, -1, `${label}: ${marker} must still be rendered`)
    const block = source.slice(source.lastIndexOf('style={{', at), at)
    const size = /fontSize: '(\d+)px'/.exec(block)
    const weight = /fontWeight: (\d+)/.exec(block)
    const colour = /color: colors\.(\w+)/.exec(block)
    assert.ok(size && weight && colour, `${label}: size, weight and colour must all be stated`)
    return { size: Number(size![1]), weight: Number(weight![1]), colour: colour![1] }
  }

  // Occurrence 0 is the stacked mobile card, occurrence 1 the desktop table:
  // the page renders the phone layout first in its `isMobile ? … : …`.
  for (const [layout, i] of [['mobile card', 0], ['desktop table', 1]] as const) {
    test(`${layout}: the code is larger, heavier and darker than the name`, () => {
      const code = styleOf('{orDash(p.itemSequence)}', i, `${layout} code`)
      const name = styleOf('{orDash(p.productName)}', i, `${layout} name`)
      assert.ok(code.size > name.size, `code ${code.size}px must be larger than name ${name.size}px`)
      assert.ok(code.weight > name.weight, `code ${code.weight} must be heavier than name ${name.weight}`)
      assert.equal(code.colour, 'primary', 'the identifier takes the darkest ink')
      assert.equal(name.colour, 'secondary', 'and the description steps back')
      // The small faint treatment the code used to have is gone for good.
      assert.ok(code.size >= 14 && code.weight >= 600, 'and it is genuinely prominent')
    })
  }

  test('neither value, nor the ordering, nor any other column moved', () => {
    assert.ok(source.includes('{orDash(p.itemSequence)}'), 'the code is the workbook’s J column')
    assert.ok(source.includes('{orDash(p.productName)}'), 'the name is the workbook’s B column')
    assert.ok(!source.includes('.sort(') && !source.includes('.reverse()'),
      'the product rows are rendered in the order the workbook carries them')
    for (const column of ['{p.quantity ?? ', '{orDash(p.dimensions)}', '{orDash(p.material)}',
                          '{formatInr(p.costPerPiece)}', '{formatInr(p.lineTotal)}']) {
      assert.ok(source.includes(column), `${column} is still rendered`)
    }
  })
})

// ── The approved section order, as the preview block renders it ───────────────

describe('the Upload PI preview renders its sections in the approved order', () => {
  const source = read(IMPORT_PAGE)
  const block = source.slice(source.indexOf('const previewBlock = preview && ('))

  const at = (marker: string) => {
    const i = block.indexOf(marker)
    assert.notEqual(i, -1, `${marker} must be rendered in the preview block`)
    return i
  }

  test('Order information, blocking errors, products, commercial summary, then the action', () => {
    const order = [
      at('buildOrderInformationRows({'),
      at('{BLOCKING_PANEL_TITLE}'),
      at('<PiProductTableHead'),
      at('<PiCommercialSummary'),
      at('READY_TITLE'),
    ]
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })

  test('the errors are read before the product list, not after it', () => {
    assert.ok(at('{BLOCKING_PANEL_TITLE}') < at('<PiProductTableHead'),
      'a blocked PI says so above the lines somebody would otherwise scroll past')
  })

  test('the Save Draft control comes after the money it commits', () => {
    assert.ok(at('<PiCommercialSummary') < at('SAVE_BUTTON_LABEL'))
  })

  test('a clean PI renders no empty error section', () => {
    const guard = block.lastIndexOf('preview.groups.blocking.length > 0 && (',
                                    at('{BLOCKING_PANEL_TITLE}'))
    assert.notEqual(guard, -1, 'the panel is gated on there being entries')
    assert.ok(guard < at('{BLOCKING_PANEL_TITLE}'))
    assert.equal((block.match(/BLOCKING_PANEL_TITLE/g) ?? []).length, 1,
      'and it is drawn once, never twice')
  })

  test('the warnings panel keeps its own gate and does not split the required order', () => {
    // "Worth checking" does not block a submission, and it is read just before
    // the decision to save — so it sits between the commercial summary and the
    // ready card. Both of those still hold their approved positions relative to
    // everything above them; the warnings interrupt nothing.
    assert.ok(at('<PiCommercialSummary') < at('{WARNING_PANEL_TITLE}'))
    assert.ok(at('{WARNING_PANEL_TITLE}') < at('READY_TITLE'))
    assert.ok(block.includes('preview.groups.warnings.length > 0 && ('),
      'and it is still shown only when there is something to check')
  })
})

// ── A product row is red only for a blocking error mapped to that row ─────────
//
// WHY THIS IS GUARDED. Red on a product line means "this line stops the
// submission". If a general commercial warning, a missing picture or anything
// else could paint it, the signal would stop meaning that — and a reader would
// start ignoring the rows that really do have to be fixed.
//
// The chain is three links, and each is asserted below:
//
//   blockingIssues  →  blockedRows  →  the row's ground / left edge
//
// so a clean PI, whose blockingIssues list is empty, produces an empty set,
// and `has()` is false for every product on the page.

describe('a product row is red only where a blocking error is mapped to it', () => {
  const source = read(IMPORT_PAGE)
  const productsCard = source.slice(source.indexOf('title="Products"'),
                                    source.indexOf('<PiCommercialSummary'))

  test('link 1 — the set is built from the blocking issues, and from nothing else', () => {
    assert.ok(source.includes('blockedRows: new Set(result.blockingIssues.map(issue => issue.row))'),
      'one row per blocking issue, keyed by the worksheet row the parser pointed at')
    assert.equal((source.match(/blockedRows:/g) ?? []).length, 2,
      'the type field and the one assignment — nothing else writes it')
  })

  test('link 2 — warnings cannot reach it', () => {
    // groupPiDiagnostics receives both lists; blockedRows receives only one.
    // A warning names a CELL as often as a row (I117 on the commercial block),
    // and it never stops a submission, so it must never mark a product.
    const at = source.indexOf('blockedRows: new Set(')
    assert.notEqual(at, -1, 'the set is still built where the preview is assembled')
    const assignment = source.slice(at, source.indexOf('coverage:', at))
    assert.ok(assignment.includes('result.blockingIssues'), 'from the blocking list')
    assert.ok(!/warning/i.test(assignment), 'no warning is folded into the blocked set')
    assert.ok(!/warning/i.test(productsCard),
      'and the product table never consults the warning list at all')
  })

  test('link 3 — both layouts ask that set, and ask nothing else', () => {
    assert.equal((productsCard.match(/preview\.blockedRows\.has\(p\.row\)/g) ?? []).length, 2,
      'the stacked card’s left edge and the table row’s ground — one each')
    assert.ok(productsCard.includes(
      "borderLeft: preview.blockedRows.has(p.row) ? `3px solid ${colors.red}` : '3px solid transparent'"),
      'the phone card’s red edge is conditional on the mapped row')
    assert.ok(productsCard.includes(
      "background: preview.blockedRows.has(p.row) ? colors.redTint : 'transparent'"),
      'and so is the table row’s pink ground')
  })

  test('a row without a mapped blocking error is left alone', () => {
    // The falsy arms are stated, not omitted: an unmarked row is explicitly
    // transparent rather than inheriting a ground from somewhere above it.
    assert.ok(productsCard.includes("? colors.redTint : 'transparent'"))
    assert.ok(productsCard.includes(": '3px solid transparent'"))
  })

  test('no other red in the products card can paint a row', () => {
    // Every remaining red token in this card belongs to the image-coverage
    // chip in the HEADER, which reports how many pictures the PI carries and
    // is not attached to any row. If a third red appears here, it is new.
    const reds = [...productsCard.matchAll(/colors\.red(?:Tint)?\b/g)].map(m => m.index!)
    const rowReds = reds.filter(i => {
      const line = productsCard.slice(productsCard.lastIndexOf('\n', i) + 1,
                                      productsCard.indexOf('\n', i))
      return line.includes('blockedRows')
    })
    const chipReds = reds.filter(i => {
      const line = productsCard.slice(productsCard.lastIndexOf('\n', i) + 1,
                                      productsCard.indexOf('\n', i))
      return line.includes('preview.coverage.complete')
    })
    assert.equal(rowReds.length, 2, 'the two row highlights')
    assert.equal(chipReds.length, 2, 'the coverage chip’s ground and its text')
    assert.equal(reds.length, rowReds.length + chipReds.length,
      'and no third source of red anywhere in the products card')
  })

  test('the derivation itself: empty in, nothing marked; a row in, that row marked', () => {
    // The expression the page runs, run here over the two cases that matter.
    // It pins the SEMANTICS the three links above pin the wiring of.
    const blockedRows = (issues: readonly { row: number }[]) => new Set(issues.map(i => i.row))

    const clean = blockedRows([])
    for (const row of [32, 33, 34]) {
      assert.equal(clean.has(row), false, `a clean PI must not mark row ${row}`)
    }

    const blocked = blockedRows([{ row: 34 }])
    assert.equal(blocked.has(34), true, 'the row the blocking issue names is marked')
    assert.equal(blocked.has(33), false, 'and its neighbours are not')
    assert.equal(blocked.has(32), false)
  })
})
