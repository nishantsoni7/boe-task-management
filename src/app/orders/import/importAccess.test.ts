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

  test('a denied caller is redirected and the screen never renders', () => {
    const source = read(IMPORT_PAGE)
    assert.ok(source.includes("router.replace('/coming-soon')"),
      'denial must land on the shared not-available page, as every other module route does')
    assert.ok(source.includes("if (access !== 'allowed') return <LoadingScreen />"),
      'children must not render in the checking or denied state')
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

describe('the New Order entry point', () => {
  test('is gated on the same capability the route enforces', () => {
    const source = read(ORDERS_DASHBOARD)
    assert.ok(source.includes('ordersCaps.canCreateOrder'), 'the button must ask the capability helper')
    assert.ok(source.includes("router.push('/orders/import')"), 'and lead to the import route')
    assert.ok(source.includes('NO_ORDERS_CAPABILITIES'),
      'capabilities must start empty so the button cannot flash before they resolve')
  })

  test('Order Requests navigation is untouched', () => {
    const nav = read(ORDERS_NAV)
    assert.ok(nav.includes("path: '/orders/requests'"), 'the Order Requests nav item must remain')
    assert.ok(nav.includes("path: '/orders/all'"), 'Confirmed Orders must remain')
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
    assert.deepEqual(rpcs, ['create_order_submission'],
      'the one RPC creates an empty draft; every figure is written by the server')
  })

  test('the only table read is the access check', () => {
    // Two `.from()` calls exist: one names a TABLE, one names the storage
    // bucket. Listing both and asserting the pair is what keeps a third from
    // appearing unnoticed.
    const targets = [...source.matchAll(/\.from\(\s*'([^']+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(targets, ['order-files', 'users'])
    assert.ok(source.includes(".from('users')"), 'the signed-in user profile')
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

  test('no "View Draft" link is offered, because no draft route exists yet', () => {
    assert.ok(!source.includes('View Draft'))
    assert.ok(source.includes('Return to Orders'))
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
    assert.ok(!source.includes('draftRef.current = null'),
      'a changed file is a new reading of the SAME editable draft')
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

  test('this phase still submits nothing for approval', () => {
    assert.ok(!source.includes('submit_order_submission'))
    assert.ok(!/Submit for Approval/i.test(source))
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
  const source = read(IMPORT_PAGE)

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
  const source = read(IMPORT_PAGE)

  test('uses dialog semantics', () => {
    assert.ok(source.includes('role="dialog"'))
    assert.ok(source.includes('aria-modal="true"'))
    assert.ok(source.includes('aria-labelledby="pi-image-viewer-title"'))
  })

  test('shows the full picture uncropped, within the viewport budget', () => {
    assert.ok(source.includes("maxWidth: '90vw'"))
    assert.ok(source.includes("maxHeight: '85vh'"))
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
    assert.ok(source.includes('thumbnailRefs.current.get(key)?.focus()'), 'and comes back')
  })

  test('it reuses the existing object URL and creates no blob of its own', () => {
    assert.ok(source.includes('src={item.url}'), 'the viewer shows the URL the table already holds')
    assert.ok(!source.includes('createObjectURL'), 'no second blob for the same bytes')
    const bagCalls = source.match(/createPiImageUrls\(/g) ?? []
    assert.equal(bagCalls.length, 1, 'URLs are created once, when the PI is read')
  })

  test('replacing the PI closes the viewer BEFORE anything is revoked', () => {
    const closeAt = source.indexOf('setViewerIndex(null)')
    const releaseAt = source.indexOf('releaseImages()')
    assert.ok(closeAt > -1 && releaseAt > -1)
    assert.ok(closeAt < releaseAt,
      'a dialog must never be left holding a revoked blob')
  })

  test('no modal or carousel dependency was added', () => {
    for (const dep of ['react-modal', 'lightbox', 'swiper', 'react-image', 'headlessui']) {
      assert.ok(!source.toLowerCase().includes(dep), `${dep} must not be introduced`)
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
  const source = read(IMPORT_PAGE)

  test('the screen branches on the value kind, not on a boolean', () => {
    assert.ok(source.includes("row.kind === 'text'"))
    assert.ok(source.includes("row.kind === 'amount'"))
    assert.ok(!source.includes('notApplicable'),
      'the page must not hard-code either worded zero; the helper supplies the words')
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
  const source = read(IMPORT_PAGE)

  test('text comes first, then the pictures', () => {
    assert.ok(source.includes('CustomizationCell'))
    assert.ok(source.includes('{hasText && ('))
    assert.ok(source.includes('{hasImages && ('))
  })

  test('"No customization" appears only when there is neither text nor images', () => {
    assert.ok(source.includes('if (!hasText && !hasImages) {'),
      'a row plainly showing four pictures must not also say it has none')
    assert.ok(source.includes('formatCustomization(text)'),
      'and the wording comes from the one tested helper, not a second copy of the rule')
  })

  test('several thumbnails wrap instead of stretching the row', () => {
    assert.ok(source.includes("flexWrap: 'wrap'"))
    assert.ok(source.includes('compact ? 34 : 30'), 'customization thumbnails are small')
  })

  test('the representative image keeps its own column and its own lookup', () => {
    assert.ok(source.includes('representativeThumbnail'))
    assert.ok(source.includes('images.representativeByRow.get(row)'))
    assert.ok(source.includes('images.customizationByRow.get(row)'))
  })

  test('a customization thumbnail is addressed by its own key, not by row', () => {
    // A row now owns several pictures; a row-keyed lookup would always resolve
    // to the representative one.
    assert.ok(source.includes('customization-${row}-${index}'))
    assert.ok(source.includes('item.key === key'))
  })

  test('every customization image gets its own thumbnail, even when they share bytes', () => {
    assert.ok(source.includes('.map((url, index) =>'),
      'the map is over IMAGES, so two changes sharing one photograph render twice')
  })
})

describe('the viewer distinguishes the two roles', () => {
  const source = read(IMPORT_PAGE)

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
    assert.ok(source.includes('key={viewerItem.key}'),
      'a row owns several pictures; keying by row would leave the dialog stale')
  })

  test('focus return is per picture', () => {
    assert.ok(source.includes('thumbnailRefs.current.get(key)?.focus()'))
  })

  test('still one URL bag, created once, for both roles', () => {
    const bagCalls = source.match(/createPiImageUrls\(/g) ?? []
    assert.equal(bagCalls.length, 1)
    assert.ok(!source.includes('createObjectURL'))
  })
})
