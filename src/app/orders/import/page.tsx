'use client'

// New Order — upload a finalized PI and read it back.
//
// PHASE 3A IS A LOOKING GLASS, NOT A DOOR. An employee picks the PI workbook
// they have already sent the client, this screen reads it and shows what BOE
// would be committing to, and then the screen forgets it. Nothing is uploaded,
// nothing is stored, no order is created, no number is allocated and no payment
// is recorded. Submission arrives in the next phase; until it does, the
// "Continue to Submission" control is deliberately inert and says so.
//
// WHY THE WORKBOOK IS PARSED IN THIS TAB. src/lib/pi has no Node-only
// dependency — fflate is isomorphic and dynamically imported, and the only
// other runtime API it touches is TextDecoder — so the same parser that will
// run on the server in Phase 3B runs here unchanged. That matters three ways:
//
//   * the file never leaves the device merely to be looked at, which is the
//     strongest privacy position available and needs no bucket, no route and
//     no cleanup job;
//   * the embedded product photographs become object URLs pointing at bytes the
//     tab already holds, instead of megabytes of base64 crossing the wire twice;
//   * there is no API response to size-limit, rate-limit or authorise.
//
// AND WHY THAT IS STILL NOT TRUSTED. A browser result is a convenience for the
// person looking at it and nothing more. Phase 3B re-parses the SAME workbook
// on the server before a single row is written, because anything computed in a
// tab is under the control of whoever owns the tab. Nothing on this screen is
// ever the basis for a saved record.
//
// PRIVACY RULES THIS FILE KEEPS. No console output of any kind — not the file
// name, not a client, not a price, not an error body. Nothing is written to
// localStorage, sessionStorage, IndexedDB, a cookie or a network request. The
// workbook bytes live in one local variable inside the handler and are dropped
// when it returns. Object URLs are released on replacement AND on unmount.
// Refreshing the page therefore clears everything, because nowhere is where it
// was kept.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileSpreadsheet, Upload, AlertTriangle, CheckCircle2, Info, Loader2,
  ImageOff, Images,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { MultilineText } from '@/components/ui/MultilineText'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
// The preview furniture is shared with /orders/drafts/[submissionId], which
// renders the SERVER'S copy of this same document. One set of components, so a
// picture, a figure or a customization cell cannot look like one thing before
// the save and another thing after it.
import {
  PiCard as Card,
  PiCardHeader as CardHeader,
  PiFieldRow as FieldRow,
  PiProductThumbnail as ProductThumbnail,
  PiCustomizationCell as CustomizationCell,
  PiDiagnosticList as DiagnosticList,
  PiCommercialSummary,
  PiImageViewer as ImageViewer,
} from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import { PI_MAX_WORKBOOK_BYTES } from '@/lib/pi/workbookReader'
import {
  checkPiFile,
  describeFileRejection,
  describePiFailure,
  formatByteLimit,
  formatInr,
  orDash,
  buildHeaderRows,
  buildCommercialRows,
  groupPiDiagnostics,
  createPiImageUrls,
  describeImageCoverage,
  describeCustomizationImageCount,
  buildImageViewerItems,
  viewerNav,
  BLOCKING_PANEL_TITLE,
  WARNING_PANEL_TITLE,
  READY_TITLE,
  PI_FILE_INPUT_ACCEPT,
  type PiFailureDisplay,
  type PiDiagnosticGroups,
  type PiImageUrls,
  type PiImageCoverage,
  type PiCustomizationImageCount,
  type PiViewerItem,
  type PiViewerNav,
} from '@/lib/pi/previewView'
import type { PiWorkbook } from '@/lib/pi/types'
import {
  SAVE_STAGES,
  SAVE_BUTTON_LABEL,
  canSaveDraft,
  describeSaveFailure,
  summariseSaveResult,
  saveStageLabel,
  saveStageIndex,
  workbookObjectPath,
  WORKBOOK_UPLOAD_MIME,
  type SaveStageKey,
  type SaveFailure,
  type SaveSuccess,
} from '@/lib/orders/saveDraftFlow'
import { draftDetailHref, draftSavedHref } from '@/lib/orders/draftsView'

// ── Screen state ──────────────────────────────────────────────────────────────

type Preview = {
  data: PiWorkbook
  groups: PiDiagnosticGroups
  images: PiImageUrls
  /** Rows carrying at least one blocking issue, so the table can mark them. */
  blockedRows: ReadonlySet<number>
  /** How many product rows have a REPRESENTATIVE picture. Per row, not per file. */
  coverage: PiImageCoverage
  /** How many customization pictures the PI carries. A plain total: they are
   *  optional, so there is no "of" to measure them against. */
  customizationCount: PiCustomizationImageCount
  /** Every openable picture of both roles, in table order. Indices into this
   *  drive the viewer. */
  viewerItems: readonly PiViewerItem[]
}

type Stage =
  | { kind: 'empty' }
  | { kind: 'parsing' }
  | { kind: 'failed'; failure: PiFailureDisplay }
  | { kind: 'ready'; preview: Preview }

const MOBILE_BREAKPOINT = 768

// ── Small presentational pieces ───────────────────────────────────────────────
//
// Card, CardHeader, FieldRow, ProductThumbnail, CustomizationCell, the image
// viewer and the commercial summary all live in @/components/orders/piPreview,
// because the saved-draft screen renders the same document from the server copy
// and the two readings must be indistinguishable. Only the pieces this screen
// alone uses are defined below.

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewOrderPiImportPage() {
  // 'checking' renders the loading screen, never the children — the same
  // discipline ModuleGuard uses, so a person without create authority never
  // sees this screen for a frame before the redirect lands.
  const [access, setAccess] = useState<'checking' | 'allowed' | 'denied'>('checking')
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'empty' })
  const [dragging, setDragging] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  /** Index into the current preview's viewerItems, or null when closed. */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  // ── Save Draft ──
  const [saveStage, setSaveStage] = useState<SaveStageKey | null>(null)
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<SaveSuccess | null>(null)
  /**
   * ATTEMPT STATE. In memory only — never localStorage, sessionStorage,
   * IndexedDB or a cookie.
   *
   * It exists so Retry means retry. `submissionId` is created once and reused
   * by every subsequent attempt, including after Change PI: a different file is
   * a new reading of the SAME editable draft, not a new draft. `workbookPath`
   * is set only once its upload has actually succeeded, so a retry after a
   * server or network failure skips straight to processing rather than
   * uploading a second copy of a file that is already there.
   *
   * Cleared only on a successful save or on deliberate abandonment (leaving the
   * screen). See the limitation note in the report: a full browser reload
   * before any save leaves an empty draft row behind.
   */
  const draftRef = useRef<{ submissionId: string; workbookPath: string | null } | null>(null)
  /** Belt and braces against a double click: state updates are async, this is
   *  not, so two clicks in the same tick cannot both start a save. */
  const savingRef = useRef(false)
  /** The chosen File, held in memory only so it can be uploaded if the employee
   *  saves. Never written to localStorage, sessionStorage or IndexedDB, and
   *  dropped when the PI is replaced or the screen unmounts. */
  const workbookFileRef = useRef<File | null>(null)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** The thumbnail that opened the viewer, so focus can go back where it came
   *  from. Keyed by worksheet row: rows are stable and unique per product. */
  const thumbnailRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const viewerOpenedFrom = useRef<string | null>(null)
  // The live object-URL bag. Held in a ref rather than in state because the
  // cleanup must run from an unmount effect that must not re-subscribe every
  // time the preview changes.
  const imagesRef = useRef<PiImageUrls | null>(null)
  /** False once the screen has gone away, so an in-flight parse cannot resurrect
   *  state or allocate object URLs that nothing is left to free. */
  const mountedRef = useRef(true)

  const releaseImages = useCallback(() => {
    imagesRef.current?.revokeAll()
    imagesRef.current = null
  }, [])

  /**
   * Close the viewer and hand focus back to the thumbnail that opened it.
   *
   * Falls back to doing nothing about focus when that thumbnail is gone — which
   * is the case when the PI has just been replaced, and where forcing focus
   * somewhere arbitrary would be worse than leaving it on the body.
   */
  const closeViewer = useCallback(() => {
    setViewerIndex(null)
    const key = viewerOpenedFrom.current
    viewerOpenedFrom.current = null
    if (key !== null) thumbnailRefs.current.get(key)?.focus()
  }, [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Every object URL is released when the page goes away. Without this, leaving
  // the screen with a 12-product PI open would strand a dozen blobs for the
  // lifetime of the tab.
  //
  // `mountedRef` closes the other half of that: reading a 10 MB workbook takes
  // long enough to walk away from, and a parse that finishes AFTER this cleanup
  // has run would otherwise create a fresh set of URLs with nothing left to
  // release them. readWorkbook checks it and revokes on the spot instead.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      releaseImages()
    }
  }, [releaseImages])

  // ── Access ──
  //
  // The route enforces `orders.create` in its own right. Hiding the entry
  // button on the dashboard is a courtesy; this is the check that matters,
  // because /orders/import can be typed, bookmarked and shared. The parent
  // layout has already required `orders.view` to open the module at all, so
  // what is added here is the narrower authority to raise an order.
  //
  // Resolved for the SIGNED-IN user, never a View As target — impersonation
  // shows an administrator what somebody else sees and must not lend or borrow
  // authority. A failed profile or permission read denies.
  useEffect(() => {
    let active = true

    const run = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: me } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      const permissions = await getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => [])
      const caps = deriveOrdersCapabilities((me as UserProfile | null)?.role, permissions)

      if (!active) return

      if (!me || !caps.canCreateOrder) {
        setAccess('denied')
        // The same destination every other denied module route uses.
        router.replace('/coming-soon')
        return
      }

      setProfile(me as UserProfile)
      setAccess('allowed')
    }

    run()
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // ── Reading a chosen workbook ──
  const readWorkbook = useCallback(async (file: File) => {
    // Guarded by the caller too; kept here so a second drop mid-parse can never
    // start a race that resolves out of order.
    setShowTechnical(false)

    // THE VIEWER CLOSES BEFORE ANYTHING IS REVOKED, on every path out of here.
    // It borrows a URL from the outgoing bag; revoking first would leave a
    // dialog holding a dead blob for the frame before React unmounted it.
    // Clearing the thumbnail map at the same time stops the outgoing products'
    // buttons from being focus targets for a preview that no longer exists.
    setViewerIndex(null)
    viewerOpenedFrom.current = null
    thumbnailRefs.current.clear()

    // A NEW WORKBOOK IS A NEW READING OF THE SAME DRAFT. The draft ROW is
    // deliberately kept — replacing the parse is exactly what the endpoint
    // supports, and creating a second submission because a file changed would
    // leave an abandoned row behind every time somebody corrected their PI.
    // Only the uploaded key is cleared, so the new file is uploaded under its
    // own path; the superseded original is removed by the server once the new
    // one has been parsed and saved.
    workbookFileRef.current = null
    if (draftRef.current) draftRef.current.workbookPath = null
    setSaveSuccess(null)
    setSaveFailure(null)

    const accepted = checkPiFile({ name: file.name, size: file.size })
    if (!accepted.ok) {
      releaseImages()
      setStage({ kind: 'failed', failure: describeFileRejection(accepted) })
      return
    }

    releaseImages()
    setStage({ kind: 'parsing' })

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Dynamic, so the parser and fflate stay out of the bundle for every
      // Orders page that never opens a workbook.
      const { parseBoePiWorkbook } = await import('@/lib/pi/masterSheetParser')
      const result = await parseBoePiWorkbook(bytes)

      if (!mountedRef.current) return

      if (!result.ok) {
        setStage({ kind: 'failed', failure: describePiFailure(result.errors) })
        return
      }

      // Kept only now that the parse succeeded, so a rejected file is not held.
      workbookFileRef.current = file

      const images = createPiImageUrls({
        representativeImages: result.data.representativeImages,
        customizationImages: result.data.customizationImages,
      })
      // Checked again: the parse above yields, and the screen can have gone away
      // in between. Revoking here is what keeps the unmount cleanup complete.
      if (!mountedRef.current) {
        images.revokeAll()
        return
      }
      imagesRef.current = images

      setStage({
        kind: 'ready',
        preview: {
          data: result.data,
          groups: groupPiDiagnostics({
            blockingIssues: result.blockingIssues,
            warnings: result.warnings,
          }),
          images,
          blockedRows: new Set(result.blockingIssues.map(issue => issue.row)),
          coverage: describeImageCoverage(result.data.products, images.representativeByRow),
          customizationCount: describeCustomizationImageCount(result.data.customizationImages),
          viewerItems: buildImageViewerItems(result.data.products, images),
        },
      })
    } catch {
      // The thrown value is deliberately not read, not shown and not logged. It
      // can carry workbook content, and there is nothing in it a person could
      // act on that the generic message does not already say.
      if (!mountedRef.current) return
      setStage({ kind: 'failed', failure: describePiFailure([]) })
    }
  }, [releaseImages])

  const parsing = stage.kind === 'parsing'
  const saving = saveStage !== null

  // ── Save Draft ──
  //
  // THREE STEPS, AND ONLY THE THIRD DECIDES ANYTHING. The draft row and the
  // upload exist so the server has something to read; the server then re-parses
  // that same workbook and persists its OWN reading. Nothing the browser
  // computed for the preview is sent, and the server's verdict overrides it.
  //
  // Retry is safe at every step: the submission id and the uploaded key are
  // remembered, so pressing Save Draft again resumes rather than starting over —
  // no second draft, no second copy of the workbook, and the server's item and
  // image keys are deterministic so a repeat write overwrites itself.
  const saveDraft = useCallback(async () => {
    if (savingRef.current) return
    if (stage.kind !== 'ready' || stage.preview.groups.blocking.length > 0) return
    if (!workbookFileRef.current) return

    savingRef.current = true
    setSaveFailure(null)

    try {
      // ── 1. The draft row, so the storage key can name it ──
      setSaveStage('creating')
      if (!draftRef.current) {
        const { data, error } = await supabase.rpc('create_order_submission', { p_client_name: null })
        if (error || !data || typeof (data as { id?: unknown }).id !== 'string') {
          setSaveFailure(describeSaveFailure('CREATE_FAILED'))
          return
        }
        draftRef.current = { submissionId: (data as { id: string }).id, workbookPath: null }
      }
      const draft = draftRef.current

      // ── 2. The workbook, straight to private storage ──
      //
      // Direct to Storage, not through an API route: a 10 MiB body is beyond a
      // serverless request limit, and routing it through a function would hold
      // the bytes in memory twice for no benefit. The order-files policies
      // already authorize exactly this employee for exactly this draft.
      setSaveStage('uploading')
      if (!draft.workbookPath) {
        const path = workbookObjectPath(draft.submissionId, crypto.randomUUID())
        const { error } = await supabase.storage
          .from('order-files')
          .upload(path, workbookFileRef.current, { contentType: WORKBOOK_UPLOAD_MIME })
        if (error) {
          // The path is NOT recorded, so a retry uploads afresh rather than
          // pointing the server at a key that may hold nothing. The preview
          // stays on screen — the parse is still valid.
          setSaveFailure(describeSaveFailure('UPLOAD_FAILED'))
          return
        }
        // Recorded only on success. Every later retry — network failure, server
        // error, a second click — reuses this exact object instead of uploading
        // the same 10 MiB again.
        draft.workbookPath = path
      }

      // ── 3. The trusted server pass ──
      setSaveStage('verifying')
      let response: Response
      try {
        response = await fetch('/api/orders/import/process-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The submission and the key. No parsed values, no workbook bytes.
          body: JSON.stringify({
            submissionId: draft.submissionId,
            sourceWorkbookPath: draft.workbookPath,
          }),
        })
      } catch {
        setSaveFailure(describeSaveFailure('NETWORK'))
        return
      }

      setSaveStage('saving')
      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        // The SERVER is authoritative. When it rejects the document, the
        // preview's "ready" verdict was wrong and the success state is never
        // shown — describeSaveFailure marks those codes so the screen can say
        // so plainly.
        setSaveFailure(describeSaveFailure(typeof body?.error === 'string' ? body.error : null))
        return
      }

      const success = summariseSaveResult(body, draft.submissionId)
      setSaveSuccess(success)

      // ── 4. Take the employee to the record that now exists ──
      //
      // A saved draft that the person who saved it cannot find is the defect
      // this navigation closes. The destination is built from the SERVER'S
      // submission id — summariseSaveResult reads it off the response — and the
      // detail page then loads the persisted rows for itself. Nothing about the
      // preview travels with it: the route carries an id, and the id is only
      // useful to somebody the database already lets read that submission.
      router.push(draftSavedHref(success.submissionId))
    } finally {
      savingRef.current = false
      setSaveStage(null)
    }
  }, [stage, supabase, router])

  const acceptFile = useCallback((file: File | null | undefined) => {
    if (!file || parsing) return
    void readWorkbook(file)
  }, [parsing, readWorkbook])

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Cleared BEFORE the async read so that choosing the SAME file again still
    // fires a change event. A file input only reports a change when its value
    // differs from what it already holds.
    e.target.value = ''
    acceptFile(file)
  }

  const openPicker = () => {
    if (parsing) return
    fileInputRef.current?.click()
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (parsing) return
    acceptFile(e.dataTransfer.files?.[0])
  }

  if (access !== 'allowed') return <LoadingScreen />

  const limitText = formatByteLimit(PI_MAX_WORKBOOK_BYTES)

  // ── Upload surface ──
  const uploader = (
    <Card>
      <div
        onDragOver={e => { e.preventDefault(); if (!parsing) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          padding: isMobile ? '28px 20px' : '36px 24px',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
          textAlign: 'center',
          background: dragging ? colors.blueTint : colors.base,
          border: dragging ? `2px dashed ${colors.blue}` : '2px dashed transparent',
          borderRadius: '10px',
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        {parsing ? (
          <Loader2 size={22} strokeWidth={1.8} color={colors.blue}
                   style={{ animation: 'boe-spin 0.8s linear infinite' }} />
        ) : (
          <FileSpreadsheet size={22} strokeWidth={1.8} color={colors.muted} />
        )}

        <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
          {parsing ? 'Reading the PI…' : 'Upload the finalized PI'}
        </div>

        <div style={{ fontSize: '12px', color: colors.secondary, maxWidth: '460px', lineHeight: 1.5 }}>
          {parsing
            ? 'This happens on your device. The file is not uploaded.'
            : <>Every commercial and product detail is read from the PI itself — there is nothing to type in.
                Excel workbook (.xlsx) only, up to {limitText}.</>}
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="boe-btn boe-btn-primary" onClick={openPicker} disabled={parsing}>
            <Upload size={13} strokeWidth={2} />
            Select Excel
          </button>
        </div>

        {!parsing && (
          <div style={{ fontSize: '11px', color: colors.muted }}>
            or drop the file here
          </div>
        )}
      </div>
    </Card>
  )

  // ── Failure ──
  const failureBlock = stage.kind === 'failed' && (
    <Card style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
      <div style={{ padding: '16px 20px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <AlertTriangle size={18} strokeWidth={1.8} color={colors.red} style={{ flexShrink: 0, marginTop: '1px' }} />
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
            {stage.failure.title}
          </div>
          <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
            {stage.failure.message}
          </div>

          {stage.failure.technical.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <button
                onClick={() => setShowTechnical(v => !v)}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontSize: '11px', color: colors.muted, textDecoration: 'underline',
                }}
              >
                {showTechnical ? 'Hide technical details' : 'Technical details'}
              </button>
              {showTechnical && (
                <div style={{
                  marginTop: '6px', padding: '8px 10px',
                  background: colors.raised, border: `1px solid ${colors.border}`,
                  borderRadius: '6px',
                  fontFamily: 'var(--font-mono)', fontSize: '11px', color: colors.secondary,
                  overflowWrap: 'anywhere',
                }}>
                  {stage.failure.technical.map((line, i) => (
                    <div key={i} style={{ marginTop: i === 0 ? 0 : '4px' }}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* No button here. The drop zone above is still on screen in this
              state and already carries "Select Excel"; a second control beside
              it was one more thing to read for the same action. */}
        </div>
      </div>
    </Card>
  )

  // ── Preview ──
  const preview = stage.kind === 'ready' ? stage.preview : null

  // The picture the viewer is showing, resolved from the CURRENT preview. When
  // a PI is replaced the index is cleared first, so this can never resolve
  // against a bag whose URLs have been revoked.
  const viewerItem = preview && viewerIndex !== null ? preview.viewerItems[viewerIndex] ?? null : null
  const nav: PiViewerNav | null = preview && viewerIndex !== null
    ? viewerNav(viewerIndex, preview.viewerItems.length)
    : null

  /** Open by viewer-item KEY, not by row: a row now owns several pictures, and
   *  a row lookup would always land on its representative image. */
  const openViewer = (key: string) => {
    if (!preview) return
    const index = preview.viewerItems.findIndex(item => item.key === key)
    if (index < 0) return
    viewerOpenedFrom.current = key
    setViewerIndex(index)
  }

  /** Stepping keeps focus-return pointed at the picture actually on screen. */
  const stepViewer = (index: number | null) => {
    if (index === null || !preview) return
    setViewerIndex(index)
    viewerOpenedFrom.current = preview.viewerItems[index]?.key ?? viewerOpenedFrom.current
  }

  const itemByKey = (key: string) => preview?.viewerItems.find(item => item.key === key)

  /** Props for one thumbnail, resolved from its viewer-item key. */
  const thumbnailFor = (key: string, url: string | undefined) => ({
    url,
    label: itemByKey(key)?.label,
    onOpen: () => openViewer(key),
    buttonRef: (el: HTMLButtonElement | null) => { thumbnailRefs.current.set(key, el) },
  })

  const representativeThumbnail = (row: number) =>
    thumbnailFor(`representative-${row}`, preview?.images.representativeByRow.get(row))

  /** One entry per customization picture on a row, in workbook order. Two of
   *  them may carry the same URL — one photograph, two requested changes — and
   *  each still gets its own thumbnail and its own place in the viewer. */
  const customizationThumbnails = (row: number) =>
    (preview?.images.customizationByRow.get(row) ?? []).map((url, index) => {
      const key = `customization-${row}-${index}`
      return { key, props: thumbnailFor(key, url) }
    })

  const previewBlock = preview && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Order information.
          B20 / sourceOrderNumber is deliberately absent — see buildHeaderRows. */}
      <Card>
        <CardHeader title="Order information" />
        <div style={{ padding: '16px 20px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '14px',
          }}>
            {buildHeaderRows(preview.data.header).map(row => (
              <FieldRow key={row.key} label={row.label} value={row.value} />
            ))}
          </div>
        </div>
      </Card>

      {/* Products */}
      <Card>
        <CardHeader
          title="Products"
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Counted per product ROW. A picture shared by four chairs is
                  four matched products, not one. */}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                padding: '2px 8px', borderRadius: '5px',
                fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                background: preview.coverage.complete ? colors.greenTint : colors.redTint,
                color: preview.coverage.complete ? '#2F7A52' : colors.red,
                border: `1px solid ${preview.coverage.complete ? 'rgba(69,168,112,0.25)' : 'rgba(217,79,79,0.25)'}`,
              }}>
                {preview.coverage.complete
                  ? <CheckCircle2 size={11} strokeWidth={2.2} />
                  : <ImageOff size={11} strokeWidth={2.2} />}
                {preview.coverage.label}
              </span>
              {/* A PLAIN TOTAL, never "4 of 12". Customization images are
                  optional, and an "of" would report eight missing files that
                  were never meant to exist. Neutral styling for the same
                  reason: none is not a problem. */}
              {preview.customizationCount.count > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px',
                  padding: '2px 8px', borderRadius: '5px',
                  fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                  background: colors.raised,
                  color: colors.secondary,
                  border: `1px solid ${colors.border}`,
                }}>
                  <Images size={11} strokeWidth={2.2} />
                  {preview.customizationCount.label}
                </span>
              )}
              <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
                {preview.data.products.length} line{preview.data.products.length !== 1 ? 's' : ''}
              </span>
            </div>
          }
        />
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {preview.data.products.map((p, i) => (
              <div
                key={p.row}
                style={{
                  padding: '14px 16px',
                  borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                  borderLeft: preview.blockedRows.has(p.row) ? `3px solid ${colors.red}` : '3px solid transparent',
                  display: 'flex', flexDirection: 'column', gap: '10px',
                }}
              >
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <ProductThumbnail {...representativeThumbnail(p.row)} size={64} />
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div style={{ fontSize: '10px', color: colors.muted, fontFamily: 'var(--font-mono)' }}>
                      {orDash(p.itemSequence)}
                    </div>
                    <MultilineText style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, margin: 0 }}>
                      {orDash(p.productName)}
                    </MultilineText>
                    <div style={{ fontSize: '12px', color: colors.secondary }}>
                      {p.quantity ?? '—'} × {formatInr(p.costPerPiece)}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <FieldRow label="Dimensions" value={orDash(p.dimensions)} />
                  <FieldRow label="Material" value={orDash(p.material)} />
                </div>
                {/* Material and customization are separate fields on the PI and
                    stay separate here — merging them would hide which of the two
                    a client actually asked for. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                  <div style={{
                    fontSize: '10px', fontWeight: 600, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>
                    Customization
                  </div>
                  <CustomizationCell
                    text={p.customization}
                    thumbnails={customizationThumbnails(p.row)}
                    compact
                  />
                </div>

                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  borderTop: `1px solid ${colors.border}`, paddingTop: '8px',
                }}>
                  <span style={{ fontSize: '11px', color: colors.muted }}>Line total</span>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                    {formatInr(p.lineTotal)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['#', 'Image', 'Product', 'Qty', 'Dimensions', 'Material', 'Customization', 'Cost / piece', 'Line total'].map((h, i) => (
                    <th key={h} style={{
                      padding: '8px 14px',
                      textAlign: i >= 7 ? 'right' : 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.data.products.map(p => (
                  <tr key={p.row} style={{
                    borderBottom: `1px solid ${colors.border}`,
                    background: preview.blockedRows.has(p.row) ? colors.redTint : 'transparent',
                  }}>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.muted, fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                      {orDash(p.itemSequence)}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <ProductThumbnail {...representativeThumbnail(p.row)} />
                    </td>
                    <td style={{ padding: '10px 14px', minWidth: '160px', maxWidth: '240px' }}>
                      <MultilineText style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, margin: 0 }}>
                        {orDash(p.productName)}
                      </MultilineText>
                    </td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.secondary }}>
                      {p.quantity ?? '—'}
                    </td>
                    <td style={{ padding: '10px 14px', minWidth: '130px', maxWidth: '200px' }}>
                      <MultilineText style={{ fontSize: '12px', color: colors.secondary, margin: 0 }}>
                        {orDash(p.dimensions)}
                      </MultilineText>
                    </td>
                    <td style={{ padding: '10px 14px', minWidth: '120px', maxWidth: '200px' }}>
                      <MultilineText style={{ fontSize: '12px', color: colors.secondary, margin: 0 }}>
                        {orDash(p.material)}
                      </MultilineText>
                    </td>
                    <td style={{ padding: '10px 14px', minWidth: '140px', maxWidth: '240px' }}>
                      <CustomizationCell
                        text={p.customization}
                        thumbnails={customizationThumbnails(p.row)}
                        compact={false}
                      />
                    </td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', textAlign: 'right', color: colors.secondary }}>
                      {formatInr(p.costPerPiece)}
                    </td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', textAlign: 'right', fontWeight: 600, color: colors.primary }}>
                      {formatInr(p.lineTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Commercial summary.

          Constrained and right-aligned by the shared component: full width on a
          phone, capped on a desktop so the labels and their figures stay close
          enough to read as pairs. The ROWS are unchanged — buildCommercialRows
          decides every label, figure and emphasis, here as on the saved draft. */}
      <PiCommercialSummary rows={buildCommercialRows(preview.data.commercial)} />

      {/* Blocking issues — always above the warnings, never merged with them. */}
      {preview.groups.blocking.length > 0 && (
        <Card style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
          <div style={{
            padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
            background: colors.redTint,
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <AlertTriangle size={15} strokeWidth={2} color={colors.red} />
            <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
              {BLOCKING_PANEL_TITLE}
            </div>
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.red, fontWeight: 600 }}>
              {preview.groups.blocking.length}
            </span>
          </div>
          <DiagnosticList entries={preview.groups.blocking} tone="red" />
          <div style={{ padding: '10px 20px', borderTop: `1px solid ${colors.border}`, fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
            Correct these in the Excel PI and upload it again. Nothing on this screen can be edited —
            the order must match the document the client was sent.
          </div>
        </Card>
      )}

      {/* Warnings — shown whether or not anything is blocking. */}
      {preview.groups.warnings.length > 0 && (
        <Card>
          <div style={{
            padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <Info size={15} strokeWidth={2} color={colors.amber} />
            <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
              {WARNING_PANEL_TITLE}
            </div>
            <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.muted }}>
              {preview.groups.warnings.length} — these do not stop a submission
            </span>
          </div>
          <DiagnosticList entries={preview.groups.warnings} tone="amber" />
        </Card>
      )}

      {/* Ready state, and the one action this phase performs. Saving stores a
          PRIVATE DRAFT — it does not submit for approval, take a payment or
          allocate an order number, and the success state says so. */}
      {preview.groups.readyToSubmit && (
        <Card style={{ borderColor: saveSuccess ? 'rgba(69,168,112,0.4)' : 'rgba(69,168,112,0.3)' }}>
          <div style={{ padding: '16px 20px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <CheckCircle2 size={18} strokeWidth={1.8} color={colors.green} style={{ flexShrink: 0, marginTop: '1px' }} />
            <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                {saveSuccess ? 'Draft saved' : READY_TITLE}
              </div>

              {saveSuccess ? (
                <>
                  <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
                    {/* The SERVER's counts, from its own re-parse — not the
                        browser's. If the two ever disagreed, what was saved is
                        what must be shown. */}
                    {saveSuccess.summary} were saved to a private draft.
                  </div>
                  <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5, marginTop: '2px' }}>
                    {saveSuccess.note}
                  </div>
                  {saveSuccess.warningCodes.length > 0 && (
                    <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                      Saved with {saveSuccess.warningCodes.length} warning
                      {saveSuccess.warningCodes.length === 1 ? '' : 's'} recorded on the draft.
                    </div>
                  )}
                  <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5, marginTop: '4px' }}>
                    Opening the saved draft…
                  </div>
                  <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {/* The save already navigates to the draft. This is the
                        fallback for the one case where it cannot — a blocked or
                        cancelled client-side navigation — so a saved record is
                        never left with nothing pointing at it. */}
                    <button
                      className="boe-btn boe-btn-primary"
                      onClick={() => router.push(draftDetailHref(saveSuccess.submissionId))}
                    >
                      Open saved draft
                    </button>
                    <button className="boe-btn boe-btn-ghost" onClick={() => router.push('/orders/drafts')}>
                      All PI Drafts
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
                    Nothing blocks this PI. Saving stores it as a private draft — the server reads the
                    workbook again and saves its own verified copy. Submitting for approval comes later.
                  </div>

                  {saving && (
                    <div style={{
                      marginTop: '8px', padding: '10px 12px',
                      background: colors.raised, border: `1px solid ${colors.border}`,
                      borderRadius: '8px',
                      display: 'flex', alignItems: 'center', gap: '8px',
                    }}>
                      <Loader2 size={14} strokeWidth={2} color={colors.blue}
                               style={{ animation: 'boe-spin 0.8s linear infinite', flexShrink: 0 }} />
                      <span style={{ fontSize: '12px', color: colors.primary, fontWeight: 600 }}>
                        {saveStageLabel(saveStage!)}
                      </span>
                      <span style={{ fontSize: '11px', color: colors.muted, marginLeft: 'auto' }}>
                        Step {saveStageIndex(saveStage!)} of {SAVE_STAGES.length}
                      </span>
                    </div>
                  )}

                  {saveFailure && (
                    <div style={{
                      marginTop: '8px', padding: '10px 12px',
                      background: colors.redTint, border: '1px solid rgba(217,79,79,0.25)',
                      borderRadius: '8px',
                    }}>
                      <div style={{ fontSize: '12px', color: colors.primary, lineHeight: 1.5 }}>
                        {saveFailure.message}
                      </div>
                      {saveFailure.serverRejectedDocument && (
                        <div style={{ fontSize: '11px', color: colors.red, marginTop: '4px', lineHeight: 1.5 }}>
                          The server checked the workbook itself and its result is the one that counts.
                          This PI is not ready to save.
                        </div>
                      )}
                      <div style={{ fontSize: '10px', color: colors.muted, marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                        {saveFailure.code}
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: '10px' }}>
                    <button
                      className="boe-btn boe-btn-primary"
                      onClick={saveDraft}
                      disabled={!canSaveDraft({
                        hasPreview: true,
                        blockingCount: preview.groups.blocking.length,
                        saving,
                        saved: false,
                      })}
                    >
                      {saving ? 'Saving…' : SAVE_BUTTON_LABEL}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* The standing promise of this screen, repeated where the eye ends up. */}
      <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.6, padding: '0 4px' }}>
        This is a preview. The workbook was read on this device and was not uploaded or saved.
        Leaving or refreshing this page clears it.
      </div>
    </div>
  )

  return (
    <OrdersLayout
      profile={profile}
      title="New Order"
      subtitle="Upload the approved PI to start a new order."
      onSignOut={handleSignOut}
      // Nothing on this screen comes from the server, so the layout's refresh
      // control would re-fetch nothing and clear nothing. Hidden here only; the
      // prop defaults to showing it, so every other Orders page is unchanged.
      showRefresh={false}
      // THE ONE replace control on the page. There is no copy of it inside the
      // preview and no "Select another PI" anywhere: the same action in three
      // places was three things to read and one to trust.
      actions={
        stage.kind === 'ready' ? (
          <button className="boe-btn boe-btn-ghost" onClick={openPicker}>
            Change PI
          </button>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '24px' }}>
        {/* Mounted for the life of the screen, NOT inside the drop zone. The
            drop zone is replaced by the preview once a PI has been read, and an
            input that unmounts with it would leave "Change PI" clicking a null
            ref — the one control a reviewer reaches for after seeing something
            wrong. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={PI_FILE_INPUT_ACCEPT}
          onChange={onInputChange}
          disabled={parsing}
          style={{ display: 'none' }}
        />
        {stage.kind !== 'ready' && uploader}
        {failureBlock}
        {previewBlock}
      </div>

      {viewerItem && nav && (
        <ImageViewer
          // Keyed by the picture, not the product: a row now owns several, and
          // keying by row would leave the dialog mounted while its contents
          // changed underneath. Remounting re-runs the focus effect and swaps
          // the image in one frame.
          key={viewerItem.key}
          item={viewerItem}
          nav={nav}
          onClose={closeViewer}
          onPrev={() => stepViewer(nav.prevIndex)}
          onNext={() => stepViewer(nav.nextIndex)}
        />
      )}
    </OrdersLayout>
  )
}
