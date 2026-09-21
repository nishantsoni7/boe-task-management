/**
 * Phase C — what the phase must NOT have changed.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * finalApproval.test.ts proves the new rules behave. finalApprovalSchema.test.ts
 * proves the migration keeps its promises. Neither would notice the failure this
 * file is for: a phase that quietly reshapes the product table, the import
 * preview or an applied migration while adding a genuinely correct approval
 * flow. Those regressions are invisible in a diff summary and catastrophic in
 * production, so they are asserted against the STARTING COMMIT itself rather
 * than against a description of it.
 *
 * The starting commit is pinned. If Phase C is ever rebased onto a later main,
 * this constant moves with it deliberately, in one place, as a visible decision.
 *
 * Reads repository files and `git show`. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/finalApprovalScope.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

/** The production SHA this phase started from. */
const BASE = '700a30c7a978ee0f6bcc92c5616bd9d6b39978f8'

const lf = (s: string) => s.replace(/\r\n/g, '\n')

/**
 * A file as it stood at the starting commit, or null when git cannot answer.
 *
 * NULL IS TOLERATED, and deliberately: a shallow clone or an exported archive
 * has no object for that commit, and a test that fails because of how the
 * repository was fetched teaches people to ignore it. Where git IS available —
 * every developer machine and CI — the comparison is exact.
 */
function atBase(path: string): string | null {
  try {
    return lf(execFileSync('git', ['show', `${BASE}:${path}`], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return null
  }
}

const now = (path: string) => lf(readFileSync(path, 'utf8'))

/** The text between two markers, exclusive of the second. */
function region(source: string, start: string, end: string, label: string): string {
  const i = source.indexOf(start)
  assert.notEqual(i, -1, `${label}: opening marker not found`)
  const j = source.indexOf(end, i)
  assert.notEqual(j, -1, `${label}: closing marker not found`)
  return source.slice(i, j)
}

const DETAIL_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const PREVIEW = 'src/components/orders/piPreview.tsx'
const IMPORT_PAGE = 'src/app/orders/import/page.tsx'
const PREVIEW_VIEW = 'src/lib/pi/previewView.ts'
const PARSER = 'src/lib/pi/masterSheetParser.ts'


/**
 * The Products card with every editing affordance taken back out.
 *
 * A block is `{canEditProducts …}` through the `)}` that closes it at the same
 * indentation, together with the JSX comment introducing it and one blank line
 * separating it from what came before. Indentation-delimited rather than
 * brace-counted on purpose: the markup is formatted, and a scan that counted
 * braces would have to understand template literals and arrow bodies to be
 * right about where a block ends.
 */
function withoutEditingBlocks(source: string): string {
  const lines = source.split('\n')
  const drop = new Set<number>()

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('{canEditProducts')) continue
    const indent = lines[i].length - lines[i].trimStart().length
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim() === ')}' && l.length - l.trimStart().length === indent) { end = j; break }
    }
    assert.notEqual(end, -1, `an editing block opened at line ${i} is never closed`)
    for (let j = i; j <= end; j++) drop.add(j)

    // The JSX comment above it, when there is one, and one blank separator.
    let k = i - 1
    if (k >= 0 && lines[k].trim().endsWith('*/}')) {
      while (k >= 0) {
        drop.add(k)
        if (lines[k].trim().startsWith('{/*')) break
        k--
      }
      k--
    }
    if (k >= 0 && lines[k].trim() === '' && !drop.has(k)) drop.add(k)
    i = end
  }

  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

// ── The product table ─────────────────────────────────────────────────────────

describe('the PI product table is byte-for-byte what it was', () => {
  test('the Products card gained editing controls and changed nothing else', () => {
    const base = atBase(DETAIL_PAGE)
    if (base === null) return

    // WHY THIS IS NO LONGER A PLAIN EQUALITY. The card was pinned byte-for-byte
    // to prove a performance pass had not disturbed it. It has since been asked
    // to carry the product editor — an Edit control on each line, a Reorder
    // control, and the statement of what only a corrected workbook can fix.
    //
    // The guarantee is kept in the form that still has teeth: UNDO THE
    // ADDITIONS AND THE ORIGINAL MUST COME BACK, line for line. Every editing
    // affordance sits inside a `{canEditProducts && …}` block, so removing
    // those blocks — and the JSX comments introducing them — must leave exactly
    // what origin/main renders. A changed column, a moved style, a dropped
    // mobile card or a figure rendered differently all survive the undo and
    // show up here.
    const MARKERS = ['{/* Products */}', '{/* ── 6. The lower information grid ──'] as const
    const undone = withoutEditingBlocks(region(now(DETAIL_PAGE), ...MARKERS, 'current'))

    assert.equal(undone, region(base, ...MARKERS, 'base'),
      'the mobile cards, the desktop table, every column and every style are unchanged')
  })

  test('and the editing controls really are there', () => {
    const MARKERS = ['{/* Products */}', '{/* ── 6. The lower information grid ──'] as const
    const card = region(now(DETAIL_PAGE), ...MARKERS, 'current')
    // Four affordances, no more: reorder, the mobile line control, the desktop
    // line control, and the note naming what needs a corrected workbook. A
    // fifth would mean the undo above was written around something new.
    assert.equal((card.match(/\{canEditProducts /g) ?? []).length, 4)
    assert.ok(card.includes('setReorderOpen(true)'))
    assert.ok(card.includes('setProductEditId(p.id)'))
    assert.ok(card.includes('PI_CHANGE_PI_ONLY'))
    // NO FIGURE ACQUIRED A CONTROL. The card renders quantities, rates and line
    // totals as it always did — as text.
    assert.ok(!/<input|<textarea/.test(card),
      'a form control appeared in the product table')
  })

  /**
   * piPreview.tsx ABOVE the commercial summary — which is the part this guard
   * is actually for.
   *
   * WHY THE WHOLE-FILE COMPARISON NARROWED (second time, same reason as the
   * import screen below). The property being protected is that a phase which
   * changes what happens AFTER submission does not quietly reshape the pieces a
   * PI is READ with: the cards, the field rows, the thumbnails and their sizes,
   * the customization cell, the nine columns, the table head, the diagnostic
   * list and the image viewer. Every one of those lives above this marker, and
   * every one of them is still held byte-for-byte.
   *
   * Below the marker is PiCommercialSummary alone, which the authorized PI
   * preview refinement redesigned — tabular figures, a grouping rule, the Grand
   * Total highlight on both screens and the advance lifted into its own
   * callout. Its FIGURES are guarded where figures belong: piDetail.render
   * .test.tsx pins the rendered labels and amounts, and importAccess.test.ts
   * holds the component to rendering what the builder hands it.
   */
  const COMMERCIAL_SECTION = '// ── The commercial summary ─'

  function previewFurniture(source: string, label: string): string {
    const at = source.indexOf(COMMERCIAL_SECTION)
    assert.notEqual(at, -1, `${label}: the commercial summary section marker must still be there`)
    return source.slice(0, at)
  }

  test('the shared table head and thumbnails are untouched', () => {
    const base = atBase(PREVIEW)
    if (base === null) return
    assert.equal(previewFurniture(now(PREVIEW), 'current'), previewFurniture(base, 'base'),
      'piPreview.tsx is shared with the import preview; a change here changes two screens')
  })

  test('and the commercial summary below it still only RENDERS', () => {
    // The one part of the file the refinement was allowed to touch, held to the
    // property that made the byte comparison worth having: it computes nothing.
    const summary = now(PREVIEW).slice(now(PREVIEW).indexOf(COMMERCIAL_SECTION))
    for (const arithmetic of ['* 0.4', 'PI_ADVANCE_PERCENT', 'Math.round', 'reduce(', 'toFixed(']) {
      assert.ok(!summary.includes(arithmetic),
        `${arithmetic} must not appear — this component renders figures, it does not derive them`)
    }
    assert.ok(!/<input|<textarea|onChange/.test(summary),
      'and no figure acquired a control')
  })

  test('the columns themselves are still the ones the workbook has', () => {
    // A belt-and-braces reading of the declaration, so a future refactor that
    // rewrote the head component would still have to keep the columns and their
    // order. The labels are read from the definition rather than the markup:
    // that is where they live, and where a change would be made.
    const columns = region(
      now(PREVIEW), 'export const PI_PRODUCT_COLUMNS', 'export function PiProductTableHead', 'columns')
    const labels = [...columns.matchAll(/label: '([^']+)'/g)].map(m => m[1])
    assert.deepEqual(labels, [
      '#', 'Image', 'Product', 'Qty', 'Dimensions', 'Material',
      'Customization', 'Cost / piece', 'Line total',
    ])
    assert.ok(columns.includes("accent: 'customization'"),
      'and Customization keeps the accent that separates it from Material')
  })
})

// ── The import preview ────────────────────────────────────────────────────────

// WHY THE WHOLE-FILE COMPARISON NARROWED.
//
// This guard read the import screen byte-for-byte against the pinned commit,
// because Phase C changes what happens AFTER a PI is submitted and nothing
// about uploading one. That is still the property worth holding. What made the
// whole-file proxy wrong is a later, deliberate layout decision: the
// ready-to-submit card — the verdict on the PI and the Save Draft button — now
// sits directly under the order information and above the product table,
// instead of at the bottom of the preview.
//
// So the guard asserts the more specific thing the byte comparison stood in
// for: the card's markup is IDENTICAL, everything around it is IDENTICAL, and
// the only difference is where the card was inserted. A change to the drop
// zone, the parse wiring, the save flow, or the card's own contents still fails
// here, exactly as it did before.

const READY_CARD_START = '{/* Ready state, and the one action this phase performs.'

/**
 * THE ORDERS & FINANCE USABILITY PASS (2026-09-18), set aside and only that:
 * the shell-and-skeleton loading state instead of the full-screen spinner, the
 * title that matches the "Upload PI" control, a way back to PI Drafts before a
 * PI is read, and `replace` after a save so Back does not land on an empty
 * upload form. Each is undone exactly; any OTHER drift on this screen still
 * fails the comparison below.
 */
function withoutUsabilityPass(src: string): string {
  const undo: [string, string][] = [
    ["import Link from 'next/link'\n", ''],
    ["import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'", "import { LoadingScreen } from '@/components/ui/atoms'"],
    ['<Suspense fallback={<OrdersRouteFallback />}>', '<Suspense fallback={<LoadingScreen />}>'],
    ["if (access === 'checking') return <OrdersRouteFallback />", "if (access === 'checking') return <LoadingScreen />"],
    [`      //
      // REPLACE, not push. The upload screen has done its job, and it holds
      // nothing once the draft is saved; left in history, Back from the new
      // draft landed on an empty upload form instead of where the reader
      // started. The draft's own Back control names PI Drafts.
      router.replace(draftSavedHref(success.submissionId))`, '      router.push(draftSavedHref(success.submissionId))'],
    [`      // The same words as the control that leads here ("Upload PI"). An Order
      // comes into existence at approval; this screen saves a PI Draft.
      title="Upload PI"
      subtitle="Upload the approved PI workbook to save it as a PI Draft for review."`, `      title="New Order"
      subtitle="Upload the approved PI to start a new order."`],
    [`      //
      // Before a PI is read there is nothing to lose, so the header offers the
      // way back to PI Drafts — the page used to have no exit but the sidebar.
      // Once a preview is on screen that link is withheld: leaving discards the
      // preview, and the one action here is replacing it.
      actions={`, '      actions={'],
    [`        ) : (
          <Link href="/orders/drafts" className="boe-btn boe-btn-ghost">
            <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" /> PI Drafts
          </Link>
        )
      }`, `        ) : undefined
      }`],
  ]
  let out = src
  for (const [is, was] of undo) {
    assert.ok(out.includes(is), `the usability-pass edit is where it was left: ${is.slice(0, 60)}`)
    out = out.replace(is, was)
  }
  return out
}

/**
 * THE LAUNCH AUDIT'S DRAFT CLEANUP (20261219000000, PR #172): a failed save no
 * longer leaves an empty PI Draft. The create carries a key, a definitive failure
 * discards the unsaved draft this screen created, and leaving the screen asks
 * the server to do the same. Undone exactly — and in reverse order — so any
 * OTHER drift on this screen still fails the comparison below.
 */
function withoutUnsavedDraftDiscard(src: string): string {
  const undo: [string, string][] = [
    [`  afterSaveFailure,
  canSaveDraft,
  describeSaveFailure,
  discardUnsavedDraft,`,
     `  canSaveDraft,
  describeSaveFailure,`],
    [`  const draftRef = useRef<{ submissionId: string; workbookPath: string | null } | null>(null)
  /**
   * ONE KEY PER UPLOAD ATTEMPT (20261219000000), sent with the create so a
   * retry after a lost response returns the SAME draft instead of a second.
   * In memory only; cleared when the draft it made is discarded.
   */
  const creationKeyRef = useRef<string | null>(null)
  /** True only for a row THIS screen created — a replacement's record is never
   *  discarded. */
  const createdHereRef = useRef(false)
`,
     `  const draftRef = useRef<{ submissionId: string; workbookPath: string | null } | null>(null)
`],
    [`  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      releaseImages()
    }
  }, [releaseImages])

  // ── A failed save leaves nothing behind (saveDraftFlow, 20261219000000) ──
  //
  // The workbook THIS attempt uploaded goes first — only when the row holds no
  // saved workbook — and then the server discards the row if, and only if, it
  // was never saved. A refusal is an answer: the row is kept for Retry.
  const discardDraft = useCallback(async (strayPaths: readonly string[]) => {
    const draft = draftRef.current
    if (!draft || !createdHereRef.current) return
    const gone = await discardUnsavedDraft(draft.submissionId, [draft.workbookPath, ...strayPaths], {
      readSavedWorkbookPath: async id => {
        const { data, error } = await supabase
          .from('order_submissions')
          .select('source_workbook_path')
          .eq('id', id)
          .maybeSingle()
        if (error) return undefined
        return (data as { source_workbook_path?: string | null } | null)?.source_workbook_path ?? null
      },
      removeWorkbook: async path => !(await supabase.storage.from('order-files').remove([path])).error,
      discard: async id => {
        const { data, error } = await supabase.rpc('discard_unsaved_order_submission', { p_submission_id: id })
        if (error) return 'failed'
        const outcome = data as { discarded?: boolean; reason?: string } | null
        return outcome?.discarded ? 'discarded' : outcome?.reason === 'absent' ? 'absent' : 'kept'
      },
    })
    if (gone && draftRef.current === draft) {
      draftRef.current = null
      creationKeyRef.current = null
      createdHereRef.current = false
    }
  }, [supabase])

  // LEAVING WITH AN UNSAVED DRAFT. The server discards it only if nothing was
  // ever saved to it; the workbook is not touched here, because a save may
  // still be finishing on the server.
  const discardOnLeave = useRef(discardDraft)
  useEffect(() => { discardOnLeave.current = discardDraft }, [discardDraft])
  useEffect(() => {
    const leave = discardOnLeave
    const saving = savingRef
    return () => {
      if (!saving.current) void leave.current([])
    }
  }, [])
`,
     `  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      releaseImages()
    }
  }, [releaseImages])
`],
    [`        // The key is KEPT on failure: if the draft was made and the answer was
        // lost, Retry returns that same draft.
        if (!creationKeyRef.current) creationKeyRef.current = crypto.randomUUID()
        const { data, error } = await supabase.rpc('create_order_submission', {
          p_client_name: null,
          p_idempotency_key: creationKeyRef.current,
        })
        if (error || !data || typeof (data as { id?: unknown }).id !== 'string') {
          setSaveFailure(describeSaveFailure('CREATE_FAILED'))
          return
        }
        draftRef.current = { submissionId: (data as { id: string }).id, workbookPath: null }
        createdHereRef.current = true
      }`,
     `        const { data, error } = await supabase.rpc('create_order_submission', { p_client_name: null })
        if (error || !data || typeof (data as { id?: unknown }).id !== 'string') {
          setSaveFailure(describeSaveFailure('CREATE_FAILED'))
          return
        }
        draftRef.current = { submissionId: (data as { id: string }).id, workbookPath: null }
      }`],
    [`          // The path is NOT recorded, so a retry uploads afresh rather than
          // pointing the server at a key that may hold nothing. The preview
          // stays on screen — the parse is still valid.
          setSaveFailure(describeSaveFailure('UPLOAD_FAILED'))
          // The draft this attempt created is discarded, and the object too in
          // case it landed before its answer was lost. Retry starts clean.
          if (afterSaveFailure({ createdHere: createdHereRef.current, ambiguous: false }) === 'discard') {
            await discardDraft([path])
          }
          return`,
     `          // The path is NOT recorded, so a retry uploads afresh rather than
          // pointing the server at a key that may hold nothing. The preview
          // stays on screen — the parse is still valid.
          setSaveFailure(describeSaveFailure('UPLOAD_FAILED'))
          return`],
    [`      } catch {
        // NO ANSWER: the server may have saved it. Everything is kept, so Retry
        // resumes the same draft and the same stored workbook.
        setSaveFailure(describeSaveFailure('NETWORK'))
        return
      }`,
     `      } catch {
        setSaveFailure(describeSaveFailure('NETWORK'))
        return
      }`],
    [`        setSaveFailure(describeSaveFailure(typeof body?.error === 'string' ? body.error : null))
        // A coded answer from the route is a decision: nothing was saved, so
        // this attempt's draft and workbook are discarded. An uncoded one (a
        // gateway timeout) is not — the save may still finish — so it is kept.
        const ambiguous = typeof body?.error !== 'string'
        if (afterSaveFailure({ createdHere: createdHereRef.current, ambiguous }) === 'discard') {
          await discardDraft([])
        }
        return
      }`,
     `        setSaveFailure(describeSaveFailure(typeof body?.error === 'string' ? body.error : null))
        return
      }`],
    [`      const success = summariseSaveResult(body, draft.submissionId)
      setSaveSuccess(success)
      // Saved: nothing about this draft is ever discarded from here now.
      createdHereRef.current = false`,
     `      const success = summariseSaveResult(body, draft.submissionId)
      setSaveSuccess(success)`],
    [`  }, [stage, supabase, router, replaceTarget, discardDraft])`,
     `  }, [stage, supabase, router, replaceTarget])`],
  ]
  let out = src
  for (const [is, was] of [...undo].reverse()) {
    assert.ok(out.includes(is), `the draft-cleanup edit is where it was left: ${is.slice(0, 60)}`)
    out = out.replace(is, was)
  }
  return out
}

/**
 * THE PI PREVIEW REFINEMENT'S PLUMBING, set aside and only that.
 *
 * The refinement is a layout task, and all of it lives in the preview block —
 * except four plumbing edits that reach above it: the order-information builder
 * it imports instead of the old one, the date formatter it borrows, the field
 * on the Preview type that carries the upload moment, and the one line that
 * fills that field when a parse succeeds.
 *
 * Each is undone exactly, so the regions compared below still hold the workbook
 * read, the save flow and the access gate to the pinned commit character for
 * character. Any OTHER drift in them still fails.
 */
function withoutUploadTimestamp(src: string): string {
  const undo: [string, string][] = [
    ['  buildOrderInformationRows,\n', '  buildHeaderRows,\n'],
    ["import { draftDetailHref, draftSavedHref, formatSavedAt } from '@/lib/orders/draftsView'",
     "import { draftDetailHref, draftSavedHref } from '@/lib/orders/draftsView'"],
    [`  viewerItems: readonly PiViewerItem[]
  /**
   * When this workbook was taken into the application, formatted for display.
   *
   * WHY THIS SCREEN HAS TO CARRY ITS OWN. Order information states an upload
   * date, and the STORED one — order_submissions.created_at — does not exist
   * yet: this screen reads the file on the device and writes nothing until the
   * employee presses Save. So the moment recorded here is the moment the parse
   * succeeded, which on this screen is the upload event.
   *
   * It is a caption and nothing else. Nothing reads it back, the save does not
   * send it, and the saved draft's own page shows created_at instead — so the
   * record's timestamp is always the server's, never this one.
   */
  readAt: string
}`,
     `  viewerItems: readonly PiViewerItem[]
}`],
    [`          viewerItems: buildImageViewerItems(result.data.products, images),
          // Read once, here, rather than in render: a clock called during
          // render would tick on every re-render and the Order information
          // block would quietly disagree with itself.
          readAt: formatSavedAt(new Date().toISOString()),
`,
     `          viewerItems: buildImageViewerItems(result.data.products, images),
`],
  ]
  let out = src
  for (const [is, was] of undo) {
    assert.ok(out.includes(is), `the PI-preview-refinement edit is where it was left: ${is.slice(0, 60)}`)
    out = out.replace(is, was)
  }
  return out
}

/** The ready-to-submit card, and the screen with that card lifted out of it. */
function readyCard(source: string, label: string): { card: string; rest: string } {
  const start = source.indexOf(READY_CARD_START)
  assert.notEqual(start, -1, `${label}: the ready-to-submit card must still be there`)
  // Its next sibling, whichever it now is: the standing-promise note when the
  // card sits last, the products card when it sits above the table.
  const ends = ['{/* The standing promise of this screen', '{/* Products */}']
    .map(marker => source.indexOf(marker, start))
    .filter(index => index !== -1)
  assert.ok(ends.length > 0, `${label}: the card must be followed by a sibling this guard knows`)
  const end = Math.min(...ends)
  return { card: source.slice(start, end), rest: source.slice(0, start) + source.slice(end) }
}

describe('the import preview and the parser are untouched', () => {
  test('the import screen still DOES exactly what it did', () => {
    const base = atBase(IMPORT_PAGE)
    if (base === null) return
    const current = withoutUploadTimestamp(
      withoutUsabilityPass(withoutUnsavedDraftDiscard(now(IMPORT_PAGE))))

    // The ready card itself — the verdict, the Save Draft button, the saving
    // and failure states — is byte-for-byte the base's, WHEREVER it now sits.
    // The refinement moved it; it did not touch a character inside it.
    assert.equal(readyCard(current, 'current').card, readyCard(base, 'base').card,
      'the verdict, the Save Draft button, the saving and failure states are unchanged')

    // And every region of the screen that DOES something rather than draws
    // something is still identical: the permission gate, the workbook read, the
    // save flow, the file acceptance, the access-denied screen, the drop zone
    // and the parse-failure panel. What the refinement changed is the preview
    // block below all of this, which is layout and nothing else.
    for (const [from, to] of [
      ['// ── Access ──',                        '// ── Reading a chosen workbook ──'],
      ['// ── Reading a chosen workbook ──',     '// ── The Orders access-denied screen ──'],
      ['// ── The Orders access-denied screen ──', '// ── Preview ──'],
    ] as const) {
      assert.equal(region(current, from, to, 'current'), region(base, from, to, 'base'),
        `${from} — Phase C still touches nothing about uploading a PI`)
    }
  })

  test('the approved section order: errors above the products, the action last', () => {
    // WHY THIS REPLACED "the ready card sits above the product table".
    //
    // That assertion pinned a layout decision that has since been superseded by
    // an authorized one. Below the product table a twelve-line PI put the
    // blocking errors under a screen and a half of scrolling; the approved
    // order reads order information, what blocks it, the lines, what it comes
    // to, and only then the control that acts on all four.
    //
    // What this guard is FOR has not changed: the import screen has exactly one
    // save control, drawn exactly once, and it is the ready card's.
    const source = now(IMPORT_PAGE)
    const order = [
      '{/* Order information.',
      '{/* Blocking issues — SECOND ON THE PAGE',
      '{/* Products */}',
      '<PiCommercialSummary',
      READY_CARD_START,
    ].map(marker => {
      const at = source.indexOf(marker)
      assert.notEqual(at, -1, `the preview must still render ${marker}`)
      return at
    })
    assert.deepEqual([...order].sort((a, b) => a - b), order,
      'Order information → blocking errors → products → commercial summary → Save Draft')
    assert.ok(source.indexOf('SAVE_BUTTON_LABEL}') > source.indexOf('<PiProductTableHead'),
      'the one control of this screen comes after the lines it commits')
    assert.equal((source.match(/READY_TITLE/g) ?? []).length, 2,
      'the import and the one rendering of it — the card is drawn once, never twice')
    assert.equal((source.match(/SAVE_BUTTON_LABEL/g) ?? []).length, 2,
      'and there is still exactly one Save Draft button on the screen')
  })

  test('the shared preview view layer gained one block and changed nothing else', () => {
    const base = atBase(PREVIEW_VIEW)
    if (base === null) return
    // THE ADDITION IS SET ASIDE, AND ONLY THE ADDITION. The PI preview
    // refinement added the Upload PI screen's own order-information builder
    // beside the existing one; it removed no line and edited none, so with that
    // block lifted out the file must still equal the pinned commit exactly.
    // formatInr, formatPiValue, formatPiDate, buildHeaderRows,
    // buildCommercialRows, computeAdvanceAmount and computeRequiredAdvance are
    // therefore all still provably untouched.
    const source = now(PREVIEW_VIEW)
    const from = source.indexOf('/**\n * Where a PI is going.')
    const to = source.indexOf('// ── Commercial summary ─')
    assert.ok(from !== -1 && to > from, 'the added block is where it was left')
    assert.equal(source.slice(0, from) + source.slice(to), base,
      'no existing formatter, builder or rule in previewView.ts changed')
  })

  test('the workbook parser is byte-for-byte what it was', () => {
    const base = atBase(PARSER)
    if (base === null) return
    // ONE LATER, DELIBERATE CHANGE is set aside, and only that one: the PI
    // header requirements (Sales Person G21, the two dates A113/E113 — owner
    // decision 2026-09-18). Everything else must still equal the starting
    // commit, so any other drift in the parser still fails here.
    const withoutHeaderRequirements = (src: string) => src
      .replace(/\n\/\*\*\n \* The three header cells a PI must fill[\s\S]*?\n {2}return issues\n\}\n/, '')
      .replace('  blockingIssues.push(...headerRequirementIssues(header))\n', '')
      .replace("import { DUE_DATE_FLOOR, isCalendarDate, plausibleDueDate } from '@/lib/orders/dueDate'\n", '')
    assert.ok(now(PARSER).includes('export function headerRequirementIssues('),
      'the set-aside block is the header-requirement rule')
    assert.equal(withoutHeaderRequirements(now(PARSER)), base,
      'no cell, no header rule and no diagnostic changed')
  })
})

// ── The applied migrations ────────────────────────────────────────────────────

// A later migration is allowed to exist — the company ships other things. What
// this guard is really protecting is that it does not REACH INTO the PI
// submission tables. Until 20260918000000 the filename was a good enough proxy
// for that, because every later file so far belonged to this feature; the first
// unrelated phase to land made the proxy wrong rather than the property wrong.
//
// So the property is now tested directly: a later file passes if it belongs to
// this feature by name, OR if it does not restructure order_submissions or its
// children. Naming one of those tables as a FOREIGN KEY TARGET or reading it is
// explicitly fine — that is what a neighbouring module is supposed to do, and it
// changes nothing about approval, deletion or the schema this suite guards.
// The ONE structural change an outside phase is allowed to make to these tables,
// and the reason it is allowed: order_submission_activity.action is a CLOSED set,
// and 20260915000000 §10 states that a phase producing a new kind of event
// extends it "in its own migration — a visible change rather than a silent new
// event type". That IS the sanctioned extension point, so a migration that only
// drops and re-adds the action CHECK is doing what the design asks of it.
//
// Nothing else is forgiven: the statements below are removed before the
// structural test runs, so a file that also alters a column, adds a policy, or
// writes a row still fails on that.
const PI_ACTIVITY_ACTION_CHECK_EXTENSION =
  /(?:execute\s+format\(\s*'alter\s+table\s+(?:public\.)?order_submission_activity\s+drop\s+constraint[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+(?:drop|add)\s+constraint\s+[^;]*order_submission_activity_action_check[^;]*;|alter\s+table\s+(?:public\.)?order_submission_activity\s+add\s+constraint\s+order_submission_activity_action_check[^;]*;)/gi

function withoutSanctionedActivityExtension(sql: string): string {
  return sql.replace(PI_ACTIVITY_ACTION_CHECK_EXTENSION, '')
}

const PI_STRUCTURAL_CHANGE =
  /(alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*|drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?order_submission\w*|(?:alter|drop|create)\s+policy\s+[^;]*\bon\s+(?:public\.)?order_submission\w*)/i

function reachesIntoPiSubmissions(file: string): boolean {
  if (/order_submission/i.test(file)) return false          // this feature's own work
  const sql = withoutSanctionedActivityExtension(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8'))
  return PI_STRUCTURAL_CHANGE.test(sql)
}

describe('no applied migration was edited, renamed or reapplied', () => {
  const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
  const CUTOFF = '20260914000000_order_submission_permanent_deletion.sql'

  test('every migration up to and including the cutoff is unchanged', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    let compared = 0

    for (const file of files.filter(f => f <= CUTOFF)) {
      const path = `supabase/migrations/${file}`
      const base = atBase(path)
      if (base === null) continue
      assert.equal(now(path), base, `${file} is applied and must never be edited`)
      compared += 1
    }

    // If git answered at all, it must have answered for the cutoff itself —
    // otherwise this suite would pass by comparing nothing.
    if (atBase(`supabase/migrations/${CUTOFF}`) !== null) {
      assert.ok(compared > 100, `expected to compare the whole applied history, compared ${compared}`)
    }
  })

  test('none of them was deleted or renamed', () => {
    const files = new Set(readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')))
    let listed: string[] = []
    try {
      listed = execFileSync('git', ['ls-tree', '--name-only', `${BASE}:supabase/migrations`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n').filter(name => name.endsWith('.sql'))
    } catch {
      return
    }
    for (const file of listed) {
      assert.ok(files.has(file), `${file} existed at the starting commit and is now missing`)
    }
  })

  test('Phase C itself added exactly one migration, after the cutoff', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const PHASE_C = '20260915000000_order_submission_final_approval.sql'
    assert.deepEqual(files.filter(f => f > CUTOFF && f <= PHASE_C), [PHASE_C])
    // Later files are allowed and must belong to this feature. 20260916000000 is
    // the Test Data Cleanup fix for the mutual foreign key Phase C introduced.
    for (const file of files.filter(f => f > PHASE_C)) {
      assert.equal(reachesIntoPiSubmissions(file), false,
        `${file} lands after Phase C and restructures the PI submission tables`)
    }
  })
})

// ── No client-side numbering, anywhere in the application ─────────────────────

describe('nothing in the browser generates or guesses an Order number', () => {
  /** Every TypeScript source under src, excluding test files. */
  function sources(dir = 'src', out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) sources(path, out)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
    }
    return out
  }

  const files = sources()

  test('there is no max(display_number) + 1, in any form', () => {
    for (const file of files) {
      const source = now(file)
      assert.ok(!/max\s*\(\s*['"]?display_number/i.test(source), `${file}`)
      assert.ok(!/display_number\s*\+\s*1/.test(source), `${file}`)
      assert.ok(!/order\('display_number'[^)]*\)[\s\S]{0,120}\.limit\(1\)/.test(source),
        `${file} reads the highest existing number, which is the same defect by another route`)
    }
  })

  test('no client code calls the allocator, or reads the cycle table', () => {
    // THE ADMIN CYCLE SCREEN IS LEGITIMATE and is deliberately not caught here:
    // get_confirmed_order_number_cycle() and set_next_confirmed_order_number()
    // are the sanctioned, admin-only doors, and Control Center calls the first
    // of them. What must never appear is the ALLOCATOR — which is revoked from
    // every role and reachable only through the INSERT trigger — or a direct
    // read of the cycle table, which has RLS with no policies at all.
    for (const file of files) {
      const source = now(file)
      for (const forbidden of [
        "rpc('allocate_confirmed_order_number'", "rpc('next_order_display_number'",
        "rpc('assign_order_display_number'", ".from('order_number_cycle')",
      ]) {
        assert.ok(!source.includes(forbidden), `${file} reaches for ${forbidden}`)
      }
    }
  })

  test('no browser writes public.orders', () => {
    for (const file of files) {
      const source = now(file)
      if (!source.includes(".from('orders')")) continue
      const usage = source.slice(source.indexOf(".from('orders')"))
      assert.ok(!/^\s*\.(insert|upsert)\(/m.test(usage.slice(0, 400)),
        `${file} inserts into public.orders; only a definer RPC may create one`)
    }
  })

  test('the PI screens send no order number to the database, ever', () => {
    for (const file of files.filter(f => f.includes('orders/drafts') || f.includes('orders/import'))) {
      const source = now(file)
      assert.ok(!/p_display_number|p_order_number|display_number:/.test(source), `${file}`)
    }
  })
})

// ── No payment writes ─────────────────────────────────────────────────────────

describe('this phase records no payment of any kind', () => {
  test('the PI screens touch no Finance or payment table', () => {
    for (const file of [DETAIL_PAGE, 'src/app/orders/drafts/page.tsx']) {
      const tables = [...now(file).matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
      for (const table of tables) {
        assert.ok(!/payment|finance/i.test(table), `${file} reads ${table}`)
      }
    }
  })

  test('the only new RPCs are the two this phase adds', () => {
    const source = now(DETAIL_PAGE)
    const rpcs = [...source.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1])
    for (const name of rpcs) {
      assert.ok(!/payment|receipt|reconcil/i.test(name), `${name} moves money`)
    }
    assert.ok(rpcs.includes('verify_pi_finance_check'))
    assert.ok(rpcs.includes('approve_order_submission'))
  })

  test('final approval happens through the new RPC and nothing else', () => {
    // One door, named once, on one screen. If a second screen ever grows an
    // approval it must be a deliberate, visible change here first.
    const callers: string[] = []
    for (const file of readdirSync('src/app', { recursive: true, withFileTypes: true }) as unknown as {
      name: string; parentPath?: string; path?: string; isFile(): boolean
    }[]) {
      if (!file.isFile() || !/\.tsx?$/.test(file.name) || /\.test\./.test(file.name)) continue
      const path = join(file.parentPath ?? file.path ?? 'src/app', file.name).split(sep).join('/')
      if (now(path).includes("rpc('approve_order_submission'")) callers.push(path)
    }
    assert.deepEqual(callers, [DETAIL_PAGE])
  })
})
