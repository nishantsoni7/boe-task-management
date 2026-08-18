'use client'

// The pieces both PI screens are made of.
//
// WHY THESE LIVE HERE RATHER THAN ON A PAGE
// -----------------------------------------
// /orders/import shows a workbook parsed in the tab; /orders/drafts/[id] shows
// the copy the server verified and stored. They are two readings of the same
// document and they must LOOK the same — a thumbnail that crops on one screen
// and not the other, or a commercial summary laid out two ways, is a reviewer
// noticing a difference the PI does not have.
//
// The alternative was a second copy of each component beside the drafts page.
// That is how the two renderings drift, and it is how a fix like "the viewer
// must never crop" gets applied to one of them and forgotten on the other. So
// there is one of each, here, and the pages supply the data.
//
// NOTHING IN THIS FILE FETCHES, WRITES, LOGS OR AUTHORIZES. Every component is a
// function of its props. The rules about what a value MEANS still live in
// src/lib/pi/previewView.ts; these only render what those helpers return.

import { useEffect, useRef } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { MultilineText } from '@/components/ui/MultilineText'
import { colors } from '@/lib/tokens'
import { useScrollLock } from '@/hooks/useScrollLock'
import { formatCustomization, type PiAmountRow, type PiViewerItem, type PiViewerNav } from '@/lib/pi/previewView'

// ── Cards and fields ──────────────────────────────────────────────────────────

export function PiCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
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

export function PiCardHeader({ title, right }: {
  /** Usually a string; a node when the heading carries a small leading icon. */
  title: React.ReactNode
  right?: React.ReactNode
}) {
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

export function PiFieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <div style={{
        fontSize: '10px', fontWeight: 600, color: colors.muted,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        {label}
      </div>
      {/* Workbook text is rendered as TEXT. React escapes it, so a cell
          containing <b>x</b> shows those characters; nothing here uses
          dangerouslySetInnerHTML. */}
      <MultilineText style={{ fontSize: '13px', color: colors.primary, margin: 0 }}>
        {value}
      </MultilineText>
    </div>
  )
}

// ── The customization accent ──────────────────────────────────────────────────
//
// WHAT IS BEING SOLVED. Customization is the one column on a PI that changes what
// a factory builds, and in a nine-column table of names, sizes and figures it
// read exactly like the eight columns that do not. A missed line here is a piece
// of furniture made wrong.
//
// WHERE THE RED GOES, AND WHERE IT DOES NOT. Colour only means "look here" while
// it is scarce, so it is spent on three things and nothing else: the column
// heading, customization text that actually exists, and the border of a
// customization photograph. A product with no customization stays completely
// neutral — no tint, no border, no chip — because a table where every row is red
// has said nothing. There is no solid red column and no red row background: the
// product name and its picture must stay the dominant thing on the line.
//
// NO REPEATED LABEL. The desktop column already says "Customization" in its
// heading and the mobile card already says it above the value, so a per-row chip
// saying it a third time would be noise. What the accent does instead is colour
// the label that is ALREADY there, and only when there is something to point at.
//
// THE TWO REDS ARE MEASURED, NOT PICKED BY EYE. BOE red (#DC1F2E) on the tint
// lands at 4.50:1 — exactly on the AA line, for 10px uppercase text, which is not
// a margin worth having. These are darker members of the same family:
//
//   header  #B3222E   6.59:1 on white, 6.05:1 on the tint
//   text    #9B1C25   8.12:1 on white
//
// Both clear AA for normal text with room to spare, and the deeper of the two
// carries the value rather than the label.

export const PI_CUSTOMIZATION_TINT = colors.redTint
export const PI_CUSTOMIZATION_HEADER_RED = '#B3222E'
export const PI_CUSTOMIZATION_TEXT_RED = '#9B1C25'
const CUSTOMIZATION_BORDER = 'rgba(217,79,79,0.45)'
const CUSTOMIZATION_RING = '0 0 0 2px rgba(217,79,79,0.16)'

// ── Thumbnail sizes ───────────────────────────────────────────────────────────
//
// A PI is a document about FURNITURE, and at 56px a wingback chair and an arm
// chair are two brown rectangles. These are the sizes at which a person can tell
// one product from another without opening anything — the table is meant to be
// read image-first, which is how the workbook itself is read.
//
// Bigger than this starts to cost more than it gives: the row grows taller than
// the text beside it, twelve products stop fitting on a screen, and the rate and
// line-total columns — the other thing this table is for — get pushed to where
// they have to be hunted for. These are the largest sizes that keep a product
// line one comfortable row.
//
// The phone values are smaller because the row is a stacked card there, and a
// full-width photograph would push the price below the fold on every product.

export const PI_THUMBNAIL_SIZE = {
  /** The product's own photograph, in the desktop table's Image column. */
  representative: 84,
  /** The same photograph in a stacked mobile card. */
  representativeCompact: 72,
  /** A picture of a requested change, beside the customization text. */
  customization: 56,
  /** The same, stacked on a phone. */
  customizationCompact: 48,
} as const

// ── Thumbnails ────────────────────────────────────────────────────────────────

/**
 * The picture anchored to a product row, or an honest gap where one is missing.
 *
 * CONTAIN, NEVER COVER. A PI carries furniture photographed in every shape there
 * is — a tall wardrobe, a wide sideboard — and `cover` fills the square by
 * cropping whatever does not fit, which on a wardrobe means showing its middle
 * and hiding the thing being ordered. The box keeps a fixed size so rows stay
 * aligned; the picture is fitted inside it whole, and the full image is one
 * click away.
 *
 * A row without a picture keeps the SAME box. Collapsing it would shorten the
 * row and slide the next product's photograph up into the gap, which is the one
 * failure that would matter here: an order line showing another line's picture.
 */
export type PiThumbnailProps = {
  url: string | undefined
  label?: string
  onOpen?: () => void
  buttonRef?: (el: HTMLButtonElement | null) => void
  /**
   * 'customization' marks a picture of a requested CHANGE rather than of the
   * product. It only ever changes the border, so the two kinds of picture are
   * told apart at a glance without either being tinted or dimmed.
   */
  accent?: 'neutral' | 'customization'
}

export function PiProductThumbnail({
  url,
  label,
  onOpen,
  buttonRef,
  accent = 'neutral',
  size = PI_THUMBNAIL_SIZE.representative,
}: PiThumbnailProps & { size?: number }) {
  const marked = accent === 'customization'
  const restingBorder = marked ? CUSTOMIZATION_BORDER : colors.border
  const box: React.CSSProperties = {
    width: size, height: size, flexShrink: 0,
    borderRadius: '6px', border: `1px solid ${restingBorder}`,
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
        // A customization thumbnail keeps its own hue on hover. Turning it blue
        // would make the one picture that is marked look like every other one at
        // the moment somebody reaches for it.
        e.currentTarget.style.borderColor = marked ? PI_CUSTOMIZATION_HEADER_RED : colors.blue
        e.currentTarget.style.boxShadow = marked ? CUSTOMIZATION_RING : '0 0 0 2px rgba(85,133,232,0.18)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = restingBorder
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {/* A plain <img>, not next/image: the source is either a blob: URL for
          bytes this tab already holds or a short-lived signed URL for a private
          object, and neither is something the optimizer can or should fetch.
          alt is empty because the button already carries the accessible name. */}
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
 * THE ACCENT IS CARRIED BY THE VALUE, NOT BY THE CELL. Where there is something
 * to do, the words are dark red and semibold and the pictures are red-bordered.
 * Where there is not, the cell is muted grey italic exactly as before — no tint,
 * no border, nothing to look at, which is what makes the rows that DO carry an
 * instruction findable at a glance.
 *
 * `label` exists for the stacked (mobile) layout, which has no column heading to
 * colour. Passing it makes the cell render its own heading and take the accent
 * onto it, so the rule about when the red appears lives here and not in two
 * copies of a card layout.
 */
export function PiCustomizationCell({
  text,
  thumbnails,
  compact,
  label,
}: {
  text: string | null
  thumbnails: readonly { key: string; props: PiThumbnailProps }[]
  compact: boolean
  /** Rendered above the value, tinted when there is a customization. */
  label?: string
}) {
  const hasText = !!text && text.trim() !== ''
  const hasImages = thumbnails.length > 0
  const marked = hasText || hasImages

  const heading = label && (
    <div style={{
      fontSize: '10px', fontWeight: marked ? 700 : 600,
      color: marked ? PI_CUSTOMIZATION_HEADER_RED : colors.muted,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      {label}
    </div>
  )

  const body = !marked
    // Through the shared helper rather than the constant directly, so the
    // "blank means none" rule has ONE implementation and its unit tests cover
    // the string these screens actually render.
    ? (
      <MultilineText style={{ fontSize: '12px', color: colors.muted, fontStyle: 'italic', margin: 0 }}>
        {formatCustomization(text)}
      </MultilineText>
    )
    : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: hasText && hasImages ? '6px' : 0 }}>
        {hasText && (
          <MultilineText style={{
            fontSize: '12px', margin: 0,
            color: PI_CUSTOMIZATION_TEXT_RED, fontWeight: 600,
          }}>
            {text}
          </MultilineText>
        )}
        {hasImages && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {thumbnails.map(t => (
              <PiProductThumbnail
                key={t.key}
                {...t.props}
                accent="customization"
                size={compact
                  ? PI_THUMBNAIL_SIZE.customizationCompact
                  : PI_THUMBNAIL_SIZE.customization}
              />
            ))}
          </div>
        )}
      </div>
    )

  if (!heading) return body

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      {heading}
      {body}
    </div>
  )
}

// ── The product table's heading row ───────────────────────────────────────────

export type PiProductColumn = {
  key: string
  label: string
  align: 'left' | 'right'
  /** The one column that gets the accent. */
  accent?: 'customization'
}

/**
 * The nine columns, defined ONCE.
 *
 * Both PI screens render the same table over the same document, so the columns,
 * their order, their alignment and the customization heading's treatment are
 * defined here rather than twice. Two copies is how the accent gets applied to
 * the upload preview and forgotten on the saved draft.
 */
export const PI_PRODUCT_COLUMNS: readonly PiProductColumn[] = [
  { key: 'sequence',      label: '#',            align: 'left' },
  { key: 'image',         label: 'Image',        align: 'left' },
  { key: 'product',       label: 'Product',      align: 'left' },
  { key: 'quantity',      label: 'Qty',          align: 'left' },
  { key: 'dimensions',    label: 'Dimensions',   align: 'left' },
  { key: 'material',      label: 'Material',     align: 'left' },
  { key: 'customization', label: 'Customization', align: 'left', accent: 'customization' },
  { key: 'cost',          label: 'Cost / piece', align: 'right' },
  { key: 'lineTotal',     label: 'Line total',   align: 'right' },
]

export function PiProductTableHead() {
  return (
    <thead>
      <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
        {PI_PRODUCT_COLUMNS.map(column => {
          const marked = column.accent === 'customization'
          return (
            <th
              key={column.key}
              style={{
                padding: '8px 14px',
                textAlign: column.align,
                fontSize: '10px', fontWeight: marked ? 700 : 600,
                // A light tint, not a filled column: the heading is what is
                // marked, and the cells below stay white so an ordinary product
                // line reads as ordinary.
                background: marked ? PI_CUSTOMIZATION_TINT : 'transparent',
                color: marked ? PI_CUSTOMIZATION_HEADER_RED : colors.muted,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
              }}
            >
              {column.label}
            </th>
          )
        })}
      </tr>
    </thead>
  )
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * A list of parser findings — blocking issues in red, warnings in amber.
 *
 * The TONE is given by the caller, because what stops a submission is the
 * parser's decision and not this component's. Nothing here promotes a warning or
 * demotes an issue; it only draws the dot in the colour it was handed.
 */
export function PiDiagnosticList({ entries, tone }: {
  entries: readonly { code: string; message: string; location: string | null; row: number | null }[]
  tone: 'red' | 'amber'
}) {
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

// ── The full-size viewer ──────────────────────────────────────────────────────

/**
 * How much of the viewport the dialog's own furniture occupies.
 *
 * THIS IS WHY THE IMAGE IS SIZED IN VIEWPORT UNITS AND NOT IN PERCENTAGES.
 *
 * The obvious layout — a column flex panel capped at 85vh, a stage with
 * `flex: 1; min-height: 0`, and an image at `max-height: 100%` — crops, and it
 * crops for a reason that is invisible on inspection: a percentage max-height
 * resolves against the containing block's height, the stage's height is `auto`
 * (it is sized BY the flex algorithm, not before it), and a percentage against
 * an indefinite height computes to `none`. So the tall image was laid out at its
 * natural size, the panel's own max-height clipped the overflow, and the bottom
 * of every portrait photograph disappeared behind the footer.
 *
 * Viewport units are definite everywhere, so the image is constrained against
 * the viewport MINUS the chrome around it. 100dvh rather than 100vh because on a
 * phone 100vh is the tall-toolbar viewport and the last strip of the picture
 * would sit behind the browser's own bar.
 *
 * The vertical budget covers: the backdrop's padding, the panel border, the
 * header, the footer (always rendered, so this number is exact whether or not
 * there is anything to step to), and the stage's padding — with headroom for a
 * header that wraps on a narrow screen. `max(160px, …)` keeps a very short
 * window showing SOMETHING rather than collapsing to nothing.
 */
const VIEWER_VERTICAL_CHROME_PX = 190
const VIEWER_HORIZONTAL_CHROME_PX = 58
/** The widest the panel gets on a large monitor. */
const VIEWER_MAX_PANEL_PX = 1100
/** The panel cap less its own border and the stage's padding. */
const VIEWER_MAX_IMAGE_PX = VIEWER_MAX_PANEL_PX - 26

export const PI_VIEWER_IMAGE_MAX_HEIGHT = `max(160px, calc(100dvh - ${VIEWER_VERTICAL_CHROME_PX}px))`
export const PI_VIEWER_IMAGE_MAX_WIDTH = `min(${VIEWER_MAX_IMAGE_PX}px, calc(100vw - ${VIEWER_HORIZONTAL_CHROME_PX}px))`

/**
 * The full picture, at a size a person can actually judge.
 *
 * Dialog semantics by hand rather than by dependency: role, aria-modal, a
 * labelled title, focus moved in on open and returned to the thumbnail on close.
 * That is the whole contract, and it is smaller than any carousel library these
 * screens would otherwise carry.
 *
 * The URL is BORROWED from whatever the page already holds — an object URL for
 * bytes in this tab, or a signed URL for a private object. The viewer creates
 * nothing and revokes nothing, so it must never outlive what it borrowed from,
 * which is why the import screen closes it before revoking anything.
 */
export function PiImageViewer({
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

  // The page behind must not scroll while this is up. Through the shared
  // reference-counted lock, so an overlay opened on top of this one cannot leave
  // the page stuck when the two unmount in the same commit.
  useScrollLock(true)

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
        // Stated rather than left to `inset: 0`, so the backdrop is the SMALL
        // viewport on a phone and the picture never ends up under the toolbar.
        height: '100dvh',
        background: 'rgba(17,19,24,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
        overflow: 'hidden',
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
          maxWidth: `min(${VIEWER_MAX_PANEL_PX}px, 100%)`,
          // The panel is sized BY the image, which is itself capped against the
          // viewport — so it fits by construction. These two are the backstop.
          maxHeight: '100%',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', gap: '12px',
          flexShrink: 0,
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
          minHeight: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '12px',
          // Neutral ground for whatever the picture does not fill. A portrait
          // photograph in a wide panel is letterboxed, not stretched.
          background: colors.raised,
          overflow: 'hidden',
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={`${item.roleLabel} — ${item.sequence} ${item.name}`}
            style={{
              // The whole picture, always. `contain` with both axes capped
              // against the viewport means a portrait shrinks to fit the height
              // and a landscape to fit the width, and neither is ever cropped.
              // width/height stay auto so a SMALL picture is centred at its own
              // size rather than blown up.
              maxWidth: PI_VIEWER_IMAGE_MAX_WIDTH,
              maxHeight: PI_VIEWER_IMAGE_MAX_HEIGHT,
              width: 'auto', height: 'auto',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        </div>

        {/* ALWAYS RENDERED, even for a lone picture. Two reasons: the height
            budget above is exact only if the footer is always there, and a
            control that appears and disappears between frames is a control
            people stop reaching for. Both buttons are simply disabled when
            there is nowhere to step. */}
        <div style={{
          padding: '10px 16px',
          borderTop: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
          flexShrink: 0,
        }}>
          {navButton(nav.canPrev, onPrev, 'Previous product image', <><ChevronLeft size={13} strokeWidth={2} />Previous</>)}
          {navButton(nav.canNext, onNext, 'Next product image', <>Next<ChevronRight size={13} strokeWidth={2} /></>)}
        </div>
      </div>
    </div>
  )
}

// ── The commercial summary ────────────────────────────────────────────────────

/**
 * The widest the summary gets on a desktop.
 *
 * A commercial summary is nine label/value pairs. Stretched across a 1920px
 * monitor each row became a label on the far left, a figure on the far right and
 * a hand's width of nothing between them — which is not just sparse, it is
 * genuinely harder to read, because pairing a label with its amount takes an eye
 * movement per row. Constrained and pushed to the right it sits directly under
 * the money column of the product table above it, where the eye already is.
 *
 * Below this width the cap does nothing and the card is full-width, which is
 * what a phone needs — so the responsiveness costs no media query and no
 * JavaScript.
 */
export const PI_COMMERCIAL_MAX_WIDTH_PX = 780

/**
 * The commercial footer of a PI.
 *
 * The rows are supplied by buildCommercialRows and rendered exactly as given.
 * NOTHING HERE COMPUTES, ROUNDS OR RECONCILES A FIGURE — not the subtotal, not
 * the GST, not the grand total, and not the advance. Two screens render this
 * component and both must show the same numbers as the document the client was
 * sent.
 */
/**
 * Which screen is rendering this summary.
 *
 * ONE COMPONENT, TWO PRESENTATIONS, AND 'preview' IS THE ORIGINAL ONE — down to
 * the last declaration. /orders/import shows a workbook the moment it is parsed;
 * its summary sits directly under a full-width product table, is the ONLY place
 * that screen states the advance requirement, and was signed off as it stands.
 * Nothing the saved-PI screen wants may reach it, so every difference below is
 * behind this flag rather than applied to both and hoped over.
 *
 * 'detail' is the saved-PI page: the summary lives in a column of a two-column
 * grid that is already narrower than the cap, so capping and right-aligning
 * again would leave a ragged gutter inside its own column; and it sits under a
 * page that states the advance condition at the top, so the figures below are a
 * calculation to be read down rather than a poster.
 *
 * WHAT NEVER VARIES is the content: both render exactly the rows they are
 * handed, and neither computes, rounds or reconciles a figure.
 */
export type PiCommercialVariant = 'preview' | 'detail'

export function PiCommercialSummary({ rows, title = 'Commercial summary', variant = 'preview' }: {
  rows: readonly PiAmountRow[]
  title?: string
  variant?: PiCommercialVariant
}) {
  const detail = variant === 'detail'
  return (
    <div style={detail ? { width: '100%' } : {
      width: '100%',
      maxWidth: `${PI_COMMERCIAL_MAX_WIDTH_PX}px`,
      marginLeft: 'auto',
    }}>
      <PiCard>
        <PiCardHeader title={title} />
        <div style={{ padding: '8px 0' }}>
          {rows.map(row => (
            <div
              key={row.key}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '16px',
                padding: row.emphasis ? '11px 18px' : '6px 18px',
                // A second hairline, on the DETAIL page only, so its column
                // reads as three groups rather than ten equal lines: what the
                // products came to, what tax does to it, and what is owed.
                // `groupStart` is set by the row builder, which is the thing
                // that knows what a row MEANS.
                borderTop: row.emphasis === 'total' || (detail && row.groupStart)
                  ? `1px solid ${colors.borderSoft}`
                  : 'none',
                // `undefined`, never 0: a falsy-but-present value would still
                // be serialised, and the preview's markup must come out exactly
                // as it did before the detail page needed anything.
                marginTop: detail && row.groupStart ? '4px' : undefined,
                paddingTop: detail && row.groupStart ? '10px' : undefined,
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
                // Detail page only: its figures line up digit under digit under
                // the products table's own money columns. The preview keeps the
                // proportional figures it shipped with.
                fontVariantNumeric: detail ? 'tabular-nums' : undefined,
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
      </PiCard>
    </div>
  )
}
