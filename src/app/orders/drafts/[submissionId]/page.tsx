'use client'

// One saved PI draft, as the SERVER stored it.
//
// EVERYTHING ON THIS SCREEN COMES OUT OF THE DATABASE.
//
// That is the whole point of the page, and it is worth stating plainly because
// the sibling screen works the opposite way round. /orders/import parses a
// workbook in the tab and shows its own reading; this one shows the reading the
// SERVER made when it re-parsed the same file and persisted the result. Those
// two can in principle disagree, and when they do, what was saved is what
// counts — a reviewer, an approver and a factory all act on the stored record.
//
// So nothing here is carried over from the upload session. No parsed workbook is
// passed through navigation state, no figure is taken from a query string, no
// preview is read out of storage of any kind, and there is no code path that
// renders a product, a price or a picture from anything other than a row this
// page fetched. The one thing the URL supplies is the submission id, and an id
// is only useful to somebody the database already lets read that submission.
//
// AUTHORIZATION IS THE DATABASE'S. There is no ownership check below. RLS
// answers it: order_submissions_select for the record, can_view_order_submission
// for its items, its pictures and its stored objects, and the restrictive module
// gate on top of all of them. A submission this caller may not read comes back
// as no rows, and no rows renders as "not found" — the same answer a genuinely
// missing id gets, so the page cannot be used to discover that a draft exists.
//
// READ-ONLY, DELIBERATELY. There is no Change PI here and no other mutation. The
// replacement flow is three steps that belong to the upload screen (upload the
// new workbook, ask the server to re-parse it, replace the stored parse), and
// half of one of them cannot safely live on a page that has no workbook in hand.
// Nothing on this screen writes.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle, CheckCircle2, Info, ArrowLeft,
  FileText, FileSpreadsheet, Clock, Package, User,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { MultilineText } from '@/components/ui/MultilineText'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import {
  PiCard,
  PiCardHeader,
  PiFieldRow,
  PiProductThumbnail,
  PiCustomizationCell,
  PiProductTableHead,
  PiDiagnosticList,
  PiCommercialSummary,
  PiImageViewer,
  PI_THUMBNAIL_SIZE,
  type PiThumbnailProps,
} from '@/components/orders/piPreview'
import { colors } from '@/lib/tokens'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import {
  buildCommercialRows,
  buildHeaderRows,
  buildImageViewerItems,
  formatInr,
  orDash,
  viewerNav,
  BLOCKING_PANEL_TITLE,
  WARNING_PANEL_TITLE,
  type PiDiagnosticEntry,
  type PiViewerItem,
  type PiViewerNav,
} from '@/lib/pi/previewView'
import {
  ORDER_FILES_BUCKET,
  PI_DRAFT_DETAIL_COLUMNS,
  PI_DRAFT_IMAGE_URL_TTL_SECONDS,
  PI_DRAFT_ITEM_COLUMNS,
  PI_DRAFT_ITEM_IMAGE_COLUMNS,
  draftStatusLabel,
  draftStatusTone,
  formatSavedAt,
  persistedCommercial,
  persistedDiagnostics,
  persistedHeader,
  persistedImageUrlMaps,
  persistedProducts,
  type PersistedItem,
  type PersistedItemImage,
  type PersistedProduct,
  type PersistedSubmission,
  type PiDraftStatusTone,
} from '@/lib/orders/draftsView'

const MOBILE_BREAKPOINT = 768

const TONE_STYLE: Record<PiDraftStatusTone, { bg: string; color: string; border: string }> = {
  neutral: { bg: colors.raised,    color: colors.secondary, border: colors.border },
  blue:    { bg: colors.blueTint,  color: '#2F5BB7',        border: 'rgba(85,133,232,0.3)' },
  amber:   { bg: colors.amberTint, color: '#9A6212',        border: 'rgba(232,160,48,0.3)' },
  red:     { bg: colors.redTint,   color: colors.red,       border: 'rgba(217,79,79,0.3)' },
  green:   { bg: colors.greenTint, color: '#2F7A52',        border: 'rgba(69,168,112,0.25)' },
}

// ── The overview section ──────────────────────────────────────────────────────
//
// WHAT WAS WRONG WITH THE VERSION THIS REPLACES. Ten fields were poured into one
// auto-filling grid, so on a wide monitor they scattered across six columns of
// roughly equal weight: the client, a date, a filename and a dispatch promise
// all looked like the same kind of fact, related fields sat nowhere near each
// other, and half the cells were an em dash — which reads as "unfinished", not
// as "the PI did not say". The card was large and told you very little quickly.
//
// The replacement has three bands and one scan order:
//
//   status  →  what this record is, on the header line
//   saved   →  a strip of four small facts about the file itself
//   order   →  the client and destination, then the dates, three to a row
//
// EMPTY IS NOT A DASH. A missing value says "Not provided" in muted text, and a
// missing FILENAME is not shown at all — a labelled block with nothing in it is
// worse than the absence it is reporting.

/** A label with its value, or an honest muted note when the PI did not say. */
function InfoField({ label, value, strong = false }: {
  label: string
  /** The shared header builder returns an em dash for anything absent. */
  value: string
  /** Client and destination read heavier than the dates below them. */
  strong?: boolean
}) {
  const missing = value.trim() === '' || value.trim() === '—'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      {missing ? (
        <div style={{ fontSize: '13px', color: colors.muted, fontStyle: 'italic' }}>
          Not provided
        </div>
      ) : (
        <MultilineText style={{
          fontSize: strong ? '14px' : '13px',
          fontWeight: strong ? 600 : 400,
          color: strong ? colors.primary : colors.secondary,
          margin: 0,
        }}>
          {value}
        </MultilineText>
      )}
    </div>
  )
}

/** One fact in the metadata strip: an icon, a label, and a short value. */
function MetaItem({ icon, label, value }: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, flexShrink: 0, marginTop: '1px',
        borderRadius: '7px', background: colors.raised,
        border: `1px solid ${colors.border}`, color: colors.tertiary,
      }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: '10px', fontWeight: 600, color: colors.muted,
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {label}
        </div>
        <div style={{
          fontSize: '12.5px', color: colors.primary, marginTop: '1px',
          overflowWrap: 'anywhere',
        }}>
          {value}
        </div>
      </div>
    </div>
  )
}

/** Everything the screen renders, assembled from the four reads. */
type Draft = {
  submission: PersistedSubmission
  products: PersistedProduct[]
  representativeByRow: ReadonlyMap<number, string>
  customizationByRow: ReadonlyMap<number, readonly string[]>
  /** Stored pictures this caller could not get a URL for. */
  unresolvedImages: number
  viewerItems: readonly PiViewerItem[]
  blocking: PiDiagnosticEntry[]
  warnings: PiDiagnosticEntry[]
}

type Load =
  | { kind: 'loading' }
  /** Missing OR not visible to this caller. One answer for both, on purpose. */
  | { kind: 'unavailable' }
  | { kind: 'failed' }
  | { kind: 'ready'; draft: Draft }

const diagnosticEntries = (value: unknown): PiDiagnosticEntry[] =>
  persistedDiagnostics(value)
    .map(entry => ({
      code: entry.code,
      message: entry.message,
      location:
        entry.row !== null && entry.cell ? `Row ${entry.row} · ${entry.cell}`
        : entry.row !== null ? `Row ${entry.row}`
        : entry.cell ? `Cell ${entry.cell}`
        : null,
      row: entry.row,
    }))
    .sort((a, b) => {
      if (a.row !== b.row) {
        if (a.row === null) return 1
        if (b.row === null) return -1
        return a.row - b.row
      }
      return a.code.localeCompare(b.code)
    })

export default function PiDraftDetailPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PiDraftDetailPageInner />
    </Suspense>
  )
}

function PiDraftDetailPageInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = useMemo(() => createClient(), [])

  const submissionId = params.submissionId as string
  /**
   * The one thing the query string is trusted for: whether to congratulate.
   *
   * It carries no data and decides nothing about what is displayed. Somebody
   * who adds ?saved=1 to a link sees a banner over a record that is loaded,
   * checked and rendered exactly as it would be without it.
   */
  const justSaved = searchParams.get('saved') === '1'

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [isMobile, setIsMobile] = useState(false)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  const thumbnailRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const viewerOpenedFrom = useRef<string | null>(null)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /**
   * Load the stored draft: the record, its product lines, its pictures, and
   * time-limited URLs for those pictures.
   *
   * THE BUCKET STAYS PRIVATE. Nothing here builds a public URL — there is none
   * to build. Each object is signed on demand through the caller's own session,
   * so the storage policies decide again, per object, whether this person may
   * see this picture. A refusal yields no URL and the table shows its honest
   * "No image" box rather than a broken one.
   *
   * `quiet` keeps the record on screen while it is re-read. The first load has
   * nothing to show and correctly shows the loading screen; a REFRESH does, and
   * blanking a page somebody is reading — losing their scroll position and
   * closing whatever they had open — is not what pressing refresh asks for. The
   * header's own spinner is the feedback, and the new data replaces the old in
   * one commit when it arrives.
   */
  const loadDraft = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setLoad({ kind: 'loading' })

    const { data: submission, error } = await supabase
      .from('order_submissions')
      .select(PI_DRAFT_DETAIL_COLUMNS)
      .eq('id', submissionId)
      .maybeSingle()

    if (error) { setLoad({ kind: 'failed' }); return }
    // No row means either "no such submission" or "not yours". The page must
    // not distinguish them, and neither does this branch.
    if (!submission) { setLoad({ kind: 'unavailable' }); return }

    const [itemsResult, imagesResult] = await Promise.all([
      supabase
        .from('order_submission_items')
        .select(PI_DRAFT_ITEM_COLUMNS)
        .eq('submission_id', submissionId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('order_submission_item_images')
        .select(PI_DRAFT_ITEM_IMAGE_COLUMNS)
        .eq('submission_id', submissionId)
        .order('position', { ascending: true }),
    ])

    if (itemsResult.error || imagesResult.error) { setLoad({ kind: 'failed' }); return }

    const products = persistedProducts((itemsResult.data ?? []) as unknown as PersistedItem[])
    const images = (imagesResult.data ?? []) as unknown as PersistedItemImage[]

    const signedByPath = new Map<string, string>()
    const paths = [...new Set(images.map(i => i.storage_path).filter(Boolean))]
    if (paths.length > 0) {
      const { data: signed } = await supabase
        .storage
        .from(ORDER_FILES_BUCKET)
        .createSignedUrls(paths, PI_DRAFT_IMAGE_URL_TTL_SECONDS)
      for (const row of signed ?? []) {
        if (row?.path && row.signedUrl && !row.error) signedByPath.set(row.path, row.signedUrl)
      }
    }

    const urls = persistedImageUrlMaps(products, images, signedByPath)
    const row = submission as unknown as PersistedSubmission

    setLoad({
      kind: 'ready',
      draft: {
        submission: row,
        products,
        representativeByRow: urls.representativeByRow,
        customizationByRow: urls.customizationByRow,
        unresolvedImages: urls.unresolved,
        // The same helper the import preview uses, so a picture is labelled and
        // ordered identically before and after the save.
        viewerItems: buildImageViewerItems(products, urls),
        blocking: diagnosticEntries(row.parse_blocking_issues),
        warnings: diagnosticEntries(row.parse_warnings),
      },
    })
  }, [supabase, submissionId])

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

      if (!active) return
      setProfile((me as UserProfile) ?? null)
      await loadDraft()
    }

    run()
    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const draft = load.kind === 'ready' ? load.draft : null

  const viewerItem = draft && viewerIndex !== null ? draft.viewerItems[viewerIndex] ?? null : null
  const nav: PiViewerNav | null = draft && viewerIndex !== null
    ? viewerNav(viewerIndex, draft.viewerItems.length)
    : null

  const closeViewer = useCallback(() => {
    setViewerIndex(null)
    const key = viewerOpenedFrom.current
    viewerOpenedFrom.current = null
    if (key !== null) thumbnailRefs.current.get(key)?.focus()
  }, [])

  const openViewer = (key: string) => {
    if (!draft) return
    const index = draft.viewerItems.findIndex(item => item.key === key)
    if (index < 0) return
    viewerOpenedFrom.current = key
    setViewerIndex(index)
  }

  const stepViewer = (index: number | null) => {
    if (index === null || !draft) return
    setViewerIndex(index)
    viewerOpenedFrom.current = draft.viewerItems[index]?.key ?? viewerOpenedFrom.current
  }

  const itemByKey = (key: string) => draft?.viewerItems.find(item => item.key === key)

  const thumbnailFor = (key: string, url: string | undefined): PiThumbnailProps => ({
    url,
    label: itemByKey(key)?.label,
    onOpen: () => openViewer(key),
    buttonRef: (el: HTMLButtonElement | null) => { thumbnailRefs.current.set(key, el) },
  })

  const representativeThumbnail = (row: number) =>
    thumbnailFor(`representative-${row}`, draft?.representativeByRow.get(row))

  const customizationThumbnails = (row: number) =>
    (draft?.customizationByRow.get(row) ?? []).map((url, index) => {
      const key = `customization-${row}-${index}`
      return { key, props: thumbnailFor(key, url) }
    })

  if (load.kind === 'loading') return <LoadingScreen />

  const backButton = (
    <button className="boe-btn boe-btn-ghost" onClick={() => router.push('/orders/drafts')}>
      <ArrowLeft size={13} strokeWidth={2} />
      PI Drafts
    </button>
  )

  if (load.kind !== 'ready' || !draft) {
    const unavailable = load.kind === 'unavailable'
    return (
      <OrdersLayout
        profile={profile}
        title="PI Draft"
        onSignOut={handleSignOut}
        showRefresh={false}
        actions={backButton}
      >
        <PiCard style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
          <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
              {unavailable ? 'This draft is not available' : 'This draft could not be loaded'}
            </div>
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, maxWidth: '520px' }}>
              {unavailable
                // One sentence for both cases. Saying "you are not allowed to
                // see this one" would confirm that it exists.
                ? 'It may have been removed, or it may belong to someone else. Open PI Drafts to see the drafts you can work with.'
                : 'The draft could not be read just now. Try again in a moment.'}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              {!unavailable && (
                <button className="boe-btn boe-btn-primary" onClick={() => void loadDraft()}>
                  Try again
                </button>
              )}
              <button className="boe-btn boe-btn-ghost" onClick={() => router.push('/orders/drafts')}>
                Go to PI Drafts
              </button>
            </div>
          </div>
        </PiCard>
      </OrdersLayout>
    )
  }

  const { submission, products } = draft
  const tone = TONE_STYLE[draftStatusTone(submission.status)]
  const savedAt = formatSavedAt(submission.updated_at ?? submission.created_at)

  /** Null unless the record actually names a workbook, so the strip can omit it. */
  const workbookName = submission.source_workbook_name?.trim() || null
  /** Whoever the PI itself named. Absent on plenty of real workbooks. */
  const createdBy = submission.source_created_by?.trim() || null

  // The shared builder still decides every LABEL and every formatted VALUE —
  // the dates, the em dash for an absent cell, and the rule that the workbook's
  // own order number is never among them. This page only picks the order it
  // shows them in, so the two PI screens cannot disagree about what a field says.
  const headerRows = buildHeaderRows(persistedHeader(submission))
  const headerValue = (key: string) => headerRows.find(row => row.key === key)?.value ?? '—'

  return (
    <OrdersLayout
      profile={profile}
      title={orDash(submission.client_name ?? submission.bill_to_name)}
      subtitle="Saved PI draft. Not submitted for approval."
      onSignOut={handleSignOut}
      // The header control re-reads in place: the record stays on screen, the
      // scroll position is kept, and the spinner in the header is the feedback.
      onRefresh={() => loadDraft({ quiet: true })}
      actions={backButton}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '24px' }}>

        {justSaved && (
          <PiCard style={{ borderColor: 'rgba(69,168,112,0.4)' }}>
            <div style={{ padding: '14px 20px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <CheckCircle2 size={17} strokeWidth={1.8} color={colors.green} style={{ flexShrink: 0, marginTop: '1px' }} />
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                  Draft saved
                </div>
                <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>
                  This is the copy the server verified and stored. It is listed under PI Drafts and can be
                  reopened at any time. No official order number has been assigned.
                </div>
              </div>
            </div>
          </PiCard>
        )}

        {/* ── Draft overview ──

            Three bands, one scan order: what state this record is in, what file
            it came from and when, then who it is for and when it is due.

            The heading is "Draft overview" and not "PI Draft": the page title,
            its subtitle and the status badge already say what this is, and a
            fourth restatement was a line of the card spent on nothing. */}
        <PiCard>
          <PiCardHeader
            title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={15} strokeWidth={1.9} color={colors.red} />
                Draft overview
              </span>
            }
            right={
              // Present, legible, and not a banner. This is a state to note in
              // passing, not the subject of the page.
              <span style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '2px 9px', borderRadius: '5px',
                fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
                background: tone.bg, color: tone.color, border: `1px solid ${tone.border}`,
              }}>
                {draftStatusLabel(submission.status)}
              </span>
            }
          />

          {/* The metadata strip: small facts about the FILE, not about the
              order. Four across on a desktop, two on a phone.

              The filename block is rendered only when there is a filename. A
              draft saved before the server recorded one has no file to name,
              and an "Original PI file —" block would be a labelled hole. */}
          <div style={{ padding: '13px 20px' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr 1fr' : `repeat(${workbookName ? 4 : 3}, minmax(0, 1fr))`,
              gap: '14px 18px',
            }}>
              <MetaItem
                icon={<Clock size={13} strokeWidth={1.9} />}
                label="Last saved"
                value={savedAt}
              />
              <MetaItem
                icon={<Package size={13} strokeWidth={1.9} />}
                label="Products"
                value={`${products.length} line${products.length === 1 ? '' : 's'}`}
              />
              <MetaItem
                icon={<User size={13} strokeWidth={1.9} />}
                label="Created by"
                value={createdBy ?? 'Not provided'}
              />
              {workbookName && (
                <MetaItem
                  icon={<FileSpreadsheet size={13} strokeWidth={1.9} />}
                  label="Original PI file"
                  value={workbookName}
                />
              )}
            </div>
          </div>

          {/* Order information — the same VALUES and the same wording as the
              import preview, because buildHeaderRows still produces them. What
              this page chooses is the arrangement: who the order is for on one
              row, when it happens on the next, three to a row so each field has
              the width to be read rather than guessed at.

              "Created by" is deliberately absent here — it is a fact about the
              document and lives in the strip above, so it is stated once. */}
          <div style={{ padding: '14px 20px 16px', borderTop: `1px solid ${colors.border}` }}>
            <div style={{
              fontSize: '11px', fontWeight: 700, color: colors.secondary,
              marginBottom: '12px',
            }}>
              Order information
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
              gap: '16px 20px',
            }}>
              {/* Row 1 — who it is for and where it goes. Heavier, because this
                  is what a reader checks first and compares across. */}
              <InfoField label="Client"    value={headerValue('client')} strong />
              <InfoField label="Bill to"   value={headerValue('billTo')} strong />
              <InfoField label="Ship to"   value={headerValue('shipTo')} strong />
              {/* Row 2 — the dates, as a quieter secondary band. */}
              <InfoField label="PI created"          value={headerValue('created')} />
              <InfoField label="Order confirmed"     value={headerValue('confirmed')} />
              <InfoField label="Dispatch commitment" value={headerValue('dispatch')} />
            </div>
          </div>

          {submission.review_note && (
            <div style={{
              padding: '12px 20px', borderTop: `1px solid ${colors.border}`,
              background: colors.amberTint,
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#9A6212', marginBottom: '2px' }}>
                What the reviewer asked for
              </div>
              <MultilineText style={{ fontSize: '12px', color: colors.primary, margin: 0 }}>
                {submission.review_note}
              </MultilineText>
            </div>
          )}
        </PiCard>

        {/* Products */}
        <PiCard>
          <PiCardHeader
            title="Products"
            right={
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {draft.unresolvedImages > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    padding: '2px 8px', borderRadius: '5px',
                    fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
                    background: colors.redTint, color: colors.red,
                    border: '1px solid rgba(217,79,79,0.25)',
                  }}>
                    {draft.unresolvedImages} image{draft.unresolvedImages === 1 ? '' : 's'} unavailable
                  </span>
                )}
                <span style={{ fontSize: '12px', color: colors.muted, whiteSpace: 'nowrap' }}>
                  {products.length} line{products.length !== 1 ? 's' : ''}
                </span>
              </div>
            }
          />

          {products.length === 0 ? (
            <div style={{ padding: '20px', fontSize: '12px', color: colors.secondary }}>
              No product lines are stored against this draft.
            </div>
          ) : isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {products.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    padding: '14px 16px',
                    borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
                    display: 'flex', flexDirection: 'column', gap: '10px',
                  }}
                >
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <PiProductThumbnail {...representativeThumbnail(p.row)} size={PI_THUMBNAIL_SIZE.representativeCompact} />
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
                    <PiFieldRow label="Dimensions" value={orDash(p.dimensions)} />
                    <PiFieldRow label="Material" value={orDash(p.material)} />
                  </div>

                  {/* The cell renders its own heading, so the accent follows the
                      same rule it does on the desktop column. */}
                  <PiCustomizationCell
                    label="Customization"
                    text={p.customization}
                    thumbnails={customizationThumbnails(p.row)}
                    compact
                  />

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
                {/* The identical head the upload preview renders. */}
                <PiProductTableHead />
                <tbody>
                  {products.map(p => (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: colors.muted, fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                        {orDash(p.itemSequence)}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <PiProductThumbnail {...representativeThumbnail(p.row)} />
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
                        <PiCustomizationCell
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
        </PiCard>

        {/* Commercial summary — the stored figures, through the shared rows
            builder. Nothing on this page recomputes a total. */}
        <PiCommercialSummary rows={buildCommercialRows(persistedCommercial(submission))} />

        {/* Saved diagnostics. Kept on the record at save time, so what the
            server thought of this document is still readable months later. */}
        {draft.blocking.length > 0 && (
          <PiCard style={{ borderColor: 'rgba(217,79,79,0.3)' }}>
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
                {draft.blocking.length}
              </span>
            </div>
            <PiDiagnosticList entries={draft.blocking} tone="red" />
            <div style={{ padding: '10px 20px', borderTop: `1px solid ${colors.border}`, fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
              Correct these in the Excel PI and upload it again from New Order. Nothing on this
              screen can be edited — the order must match the document the client was sent.
            </div>
          </PiCard>
        )}

        {draft.warnings.length > 0 && (
          <PiCard>
            <div style={{
              padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <Info size={15} strokeWidth={2} color={colors.amber} />
              <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                {WARNING_PANEL_TITLE}
              </div>
              <span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.muted }}>
                {draft.warnings.length} recorded when this draft was saved
              </span>
            </div>
            <PiDiagnosticList entries={draft.warnings} tone="amber" />
          </PiCard>
        )}

        <div style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.6, padding: '0 4px' }}>
          This is the stored copy of the PI, read back from the server. It carries no official order
          number: numbering happens only after management approval.
        </div>
      </div>

      {viewerItem && nav && (
        <PiImageViewer
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
