'use client'

import { colors } from '@/lib/tokens'

// ── The module's loading placeholders ────────────────────────────────────────
//
// ONE SHAPE PER SURFACE, and each is the shape of the thing that will replace
// it: card grids get card-sized blocks, stat rows get stat-sized blocks, the
// progress table gets rows. That is the whole point of a skeleton — the layout
// does not jump when the data lands.
//
// NO ANIMATION. The BOE convention here is a flat muted block (see the review
// queue's own CardSkeletons, which these match): a pulsing shimmer draws the
// eye to the part of the screen that is, by definition, not worth looking at
// yet. `aria-busy` is what actually announces the state.

const BLOCK: React.CSSProperties = {
  borderRadius: '10px',
  border: `1px solid ${colors.border}`,
  background: colors.raised,
  opacity: 0.6,
}

/** A row of stat tiles — Overview's four, My Reviews' three. */
export function StatSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      style={{
        display: 'grid', gap: '10px',
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 160px), 1fr))`,
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ ...BLOCK, height: '72px' }} />
      ))}
    </div>
  )
}

/** A grid of review cards. Matches ReviewCardGrid's tracks exactly. */
export function CardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading reviews"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
        maxWidth: '900px', gap: '12px',
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ ...BLOCK, height: '196px' }} />
      ))}
    </div>
  )
}

/** Stacked full-width blocks — batches, project groups, list rows. */
export function StackSkeleton({ count = 3, height = 88 }: { count?: number; height?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ ...BLOCK, height: `${height}px` }} />
      ))}
    </div>
  )
}

/**
 * A grid of project photographs, on the same tracks ProjectImages draws.
 *
 * SIZED IN TILES, NOT IN LINES. The thing it stands in for is a square grid, so
 * a line of text saying "Loading…" made the sheet jump by a hundred-odd pixels
 * the moment the images landed — under the review body, which somebody is
 * reading at the time.
 */
export function ImageGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading the project images"
      style={{
        display: 'grid', gap: '8px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ ...BLOCK, aspectRatio: '1 / 1', borderRadius: '8px' }} />
      ))}
    </div>
  )
}
