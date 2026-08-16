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
  X, ChevronLeft, ChevronRight, ImageOff, Images,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { MultilineText } from '@/components/ui/MultilineText'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
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
  formatCustomization,
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
  type PiDiagnosticEntry,
  type PiDiagnosticGroups,
  type PiImageUrls,
  type PiImageCoverage,
  type PiCustomizationImageCount,
  type PiViewerItem,
  type PiViewerNav,
} from '@/lib/pi/previewView'
import type { PiWorkbook } from '@/lib/pi/types'

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

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: colors.base,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      overflow: 'hidden',
      ...style,
    }}>
      {children}
    </div>
  )
}

function CardHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{
      padding: '14px 20px',
      borderBottom: `1px solid ${colors.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{title}</div>
      {right}
    </div>
  )
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      {/* Workbook text is rendered as TEXT. React escapes it, so a cell
          containing <b>x</b> shows those characters; nothing on this screen
          uses dangerouslySetInnerHTML. */}
      <MultilineText style={{ fontSize: '13px', color: colors.primary, margin: 0 }}>
        {value}
      </MultilineText>
    </div>
  )
}

/**
 * The picture anchored to a product row, or an honest gap where one is missing.
 *
 * CONTAIN, NEVER COVER. A PI carries furniture photographed in every shape
 * there is — a tall wardrobe, a wide sideboard — and `cover` fills the square by
 * cropping whatever does not fit, which on a wardrobe means showing its middle
 * and hiding the thing being ordered. The box keeps a fixed size so rows stay
 * aligned; the picture is fitted inside it whole, and the full image is one
 * click away.
 *
 * A row without a picture keeps the SAME box. Collapsing it would shorten the
 * row and slide the next product's photograph up into the gap, which is the one
 * failure that would matter here: an order line showing another line's picture.
 */
type ThumbnailProps = {
  url: string | undefined
  label?: string
  onOpen?: () => void
  buttonRef?: (el: HTMLButtonElement | null) => void
}

function ProductThumbnail({
  url,
  label,
  onOpen,
  buttonRef,
  size = 56,
}: ThumbnailProps & { size?: number }) {
  const box: React.CSSProperties = {
    width: size, height: size, flexShrink: 0,
    borderRadius: '6px', border: `1px solid ${colors.border}`,
    background: colors.raised, overflow: 'hidden',
  }

  if (!url) {
    return (
      <div
        style={{
          ...box,
          borderStyle: 'dashed',
          borderColor: 'rgba(217,79,79,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '9px', color: colors.red, textAlign: 'center', padding: '4px', lineHeight: 1.2,
        }}
      >
        No image
      </div>
    )
  }

  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onOpen}
      aria-label={label}
      title={label}
      style={{
        ...box,
        padding: 0,
        cursor: 'zoom-in',
        display: 'block',
        position: 'relative',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = colors.blue
        e.currentTarget.style.boxShadow = '0 0 0 2px rgba(85,133,232,0.18)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = colors.border
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {/* A plain <img>, not next/image: the source is a blob: URL for bytes this
          tab already holds, so there is nothing for the optimizer to fetch. alt
          is empty because the button already carries the accessible name. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    </button>
  )
}

/**
 * The full picture, at a size a person can actually judge.
 *
 * Reuses the object URL the table already holds — a modal that created its own
 * blob would double the memory for the same bytes and leave a second URL to
 * leak. Since it borrows, it must never outlive the bag it borrowed from, which
 * is why replacing the PI closes this before revoking anything.
 *
 * Dialog semantics by hand rather than by dependency: role, aria-modal, a
 * labelled title, focus moved in on open and returned to the thumbnail on
 * close. That is the whole contract, and it is smaller than any carousel
 * library this screen would otherwise carry.
 */
function ImageViewer({
  item,
  nav,
  onClose,
  onPrev,
  onNext,
}: {
  item: PiViewerItem
  nav: PiViewerNav
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Focus lands on Close: it is the control every keyboard user wants first,
  // and it anchors Tab inside the dialog's own controls.
  useEffect(() => { closeRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowLeft' && nav.canPrev) { e.preventDefault(); onPrev(); return }
      if (e.key === 'ArrowRight' && nav.canNext) { e.preventDefault(); onNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav.canPrev, nav.canNext, onClose, onPrev, onNext])

  const navButton = (enabled: boolean, onClick: () => void, label: string, glyph: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={label}
      className="boe-btn boe-btn-ghost"
      style={{
        background: colors.base,
        opacity: enabled ? 1 : 0.4,
        cursor: enabled ? 'pointer' : 'not-allowed',
      }}
    >
      {glyph}
    </button>
  )

  return (
    <div
      // Clicking the backdrop closes. The dialog panel below stops propagation,
      // so a click that lands on the picture, the caption or a button does not
      // reach here and does not close the viewer.
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(17,19,24,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pi-image-viewer-title"
        onClick={e => e.stopPropagation()}
        style={{
          background: colors.base,
          border: `1px solid ${colors.border}`,
          borderRadius: '12px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', gap: '12px',
        }}>
          <div id="pi-image-viewer-title" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              {/* WHAT AM I LOOKING AT. Stated on every frame, because a single
                  sequence mixes the product with pictures of changes to it and
                  a reviewer must never have to infer which. */}
              <span style={{
                padding: '1px 6px', borderRadius: '4px',
                fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
                textTransform: 'uppercase', letterSpacing: '0.04em',
                background: item.role === 'customization' ? colors.amberTint : colors.blueTint,
                color: item.role === 'customization' ? '#9A6212' : '#2F5BB7',
                border: `1px solid ${item.role === 'customization' ? 'rgba(232,160,48,0.3)' : 'rgba(85,133,232,0.3)'}`,
              }}>
                {item.roleLabel}
              </span>
              <span style={{ fontSize: '11px', color: colors.muted, fontFamily: 'var(--font-mono)' }}>
                {item.sequence}
              </span>
            </div>
            <div style={{
              fontSize: '13px', fontWeight: 600, color: colors.primary,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {item.name}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: colors.muted, whiteSpace: 'nowrap' }}>
              {nav.position}
            </span>
            <button
              type="button"
              ref={closeRef}
              onClick={onClose}
              className="boe-btn boe-btn-ghost"
              aria-label="Close image viewer"
            >
              <X size={13} strokeWidth={2} />
              Close
            </button>
          </div>
        </div>

        <div style={{
          flex: 1, minHeight: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '12px', background: colors.raised,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={`${item.roleLabel} — ${item.sequence} ${item.name}`}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>

        {(nav.canPrev || nav.canNext) && (
          <div style={{
            padding: '10px 16px',
            borderTop: `1px solid ${colors.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
          }}>
            {navButton(nav.canPrev, onPrev, 'Previous product image', <><ChevronLeft size={13} strokeWidth={2} />Previous</>)}
            {navButton(nav.canNext, onNext, 'Next product image', <>Next<ChevronRight size={13} strokeWidth={2} /></>)}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The customization cell: what should change, and pictures of it.
 *
 * TEXT FIRST, then the illustrations, because the words say what to do and the
 * pictures show it. The three states are distinct on purpose:
 *
 *   text, no images    → the text, alone
 *   images, no text    → the thumbnails, with NO "No customization" above them.
 *                        A row that plainly carries four pictures must not also
 *                        announce that it has no customization.
 *   neither            → "No customization", which says the PI was read and
 *                        there is none — not that something is missing.
 *
 * Thumbnails are small and wrap, so a product with several changes does not
 * stretch its table row past the others.
 */
function CustomizationCell({
  text,
  thumbnails,
  compact,
}: {
  text: string | null
  thumbnails: readonly { key: string; props: ThumbnailProps }[]
  compact: boolean
}) {
  const hasText = !!text && text.trim() !== ''
  const hasImages = thumbnails.length > 0

  if (!hasText && !hasImages) {
    // Through the shared helper rather than the constant directly, so the
    // "blank means none" rule has ONE implementation and its unit tests cover
    // the string this screen actually renders.
    return (
      <MultilineText style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
        {formatCustomization(text)}
      </MultilineText>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: hasText && hasImages ? '6px' : 0 }}>
      {hasText && (
        <MultilineText style={{ fontSize: '12px', color: colors.secondary, margin: 0 }}>
          {text}
        </MultilineText>
      )}
      {hasImages && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {thumbnails.map(t => (
            <ProductThumbnail key={t.key} {...t.props} size={compact ? 34 : 30} />
          ))}
        </div>
      )}
    </div>
  )
}

function DiagnosticList({ entries, tone }: { entries: readonly PiDiagnosticEntry[]; tone: 'red' | 'amber' }) {
  const accent = tone === 'red' ? colors.red : colors.amber
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
      {entries.map((entry, i) => (
        <li
          key={`${entry.code}-${entry.row ?? 'x'}-${i}`}
          style={{
            display: 'flex', gap: '10px', alignItems: 'flex-start',
            padding: '10px 20px',
            borderTop: i === 0 ? 'none' : `1px solid ${colors.border}`,
          }}
        >
          <span style={{
            flexShrink: 0, marginTop: '2px',
            width: '6px', height: '6px', borderRadius: '50%', background: accent,
          }} />
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {entry.location && (
              <div style={{ fontSize: '11px', fontWeight: 600, color: accent }}>{entry.location}</div>
            )}
            <MultilineText style={{ fontSize: '12px', color: colors.secondary, margin: 0 }}>
              {entry.message}
            </MultilineText>
          </div>
        </li>
      ))}
    </ul>
  )
}

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

      {/* Commercial summary */}
      <Card>
        <CardHeader title="Commercial summary" />
        <div style={{ padding: '8px 0' }}>
          {buildCommercialRows(preview.data.commercial).map(row => (
            <div
              key={row.key}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px',
                padding: row.emphasis ? '12px 20px' : '7px 20px',
                borderTop: row.emphasis === 'total' ? `1px solid ${colors.borderSoft}` : 'none',
                background: row.emphasis === 'advance' ? colors.amberTint : 'transparent',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: row.emphasis ? '13px' : '12px',
                  fontWeight: row.emphasis ? 700 : 400,
                  color: row.emphasis ? colors.primary : colors.secondary,
                }}>
                  {row.label}
                </div>
                {row.note && (
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '2px' }}>
                    {row.note}
                  </div>
                )}
              </div>
              <div style={{
                whiteSpace: row.kind === 'text' ? 'normal' : 'nowrap',
                textAlign: 'right',
                fontSize: row.emphasis ? '14px' : '13px',
                fontWeight: row.emphasis ? 700 : 500,
                // The two worded zeroes read as settled facts, like a figure,
                // so they take the primary colour; italic marks all three
                // non-numeric renderings as words rather than amounts.
                color: row.kind === 'text' || row.kind === 'missing' ? colors.secondary : colors.primary,
                fontStyle: row.kind === 'amount' || row.kind === 'missing' ? 'normal' : 'italic',
              }}>
                {row.value}
              </div>
            </div>
          ))}
        </div>
      </Card>

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

      {/* Ready state. The button is inert on purpose: this phase saves nothing,
          and a control that looked like it did would be a lie about a
          commercial record. */}
      {preview.groups.readyToSubmit && (
        <Card style={{ borderColor: 'rgba(69,168,112,0.3)' }}>
          <div style={{ padding: '16px 20px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <CheckCircle2 size={18} strokeWidth={1.8} color={colors.green} style={{ flexShrink: 0, marginTop: '1px' }} />
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{READY_TITLE}</div>
              <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
                Nothing blocks this PI. Saving it and sending it for management approval is not available
                yet — it arrives in the next phase. Nothing has been stored.
              </div>
              <div style={{ marginTop: '8px' }}>
                <button className="boe-btn boe-btn-primary" disabled title="Available in the next phase">
                  Continue to Submission
                </button>
              </div>
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
