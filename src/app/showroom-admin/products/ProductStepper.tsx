'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { ProductNeighbors } from '@/lib/showroom/productNav'

// Previous/Next through the run of products the user was browsing.
//
// The point is to remove a round trip through Product Master between every
// edit, so it is deliberately small: two codes and a position, on one line,
// under the Back control. No toolbar, no dropdown, no page-jump — anything
// bigger would compete with the form it sits above.
//
// A boundary shows nothing rather than a dead control: the first product has no
// Previous to grey out, and an inert button that looks clickable is worse than
// an absent one. The row keeps its shape either way because both ends are
// always laid out, occupied or not.

export function ProductStepper({
  neighbors, onNavigate,
}: {
  neighbors: ProductNeighbors
  onNavigate: (productCode: string) => void
}) {
  const { previous, next, position, total } = neighbors

  // Nothing to step through — a lone product in its category, or a run this
  // product is not part of. Showing an empty frame would just be noise.
  if (!previous && !next) return null

  return (
    <nav
      aria-label="Product navigation"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', flexWrap: 'wrap',
        marginBottom: '14px',
      }}
    >
      {previous
        ? <StepButton code={previous} direction="previous" onClick={() => onNavigate(previous)} />
        : <span />}

      {position !== null && total > 0 && (
        <span style={{
          fontSize: '11.5px', color: colors.muted,
          whiteSpace: 'nowrap',
        }}>
          {position} of {total}
        </span>
      )}

      {next
        ? <StepButton code={next} direction="next" onClick={() => onNavigate(next)} />
        : <span />}
    </nav>
  )
}

function StepButton({
  code, direction, onClick,
}: {
  code: string
  direction: 'previous' | 'next'
  onClick: () => void
}) {
  const isPrevious = direction === 'previous'
  return (
    <button
      type="button"
      onClick={onClick}
      // The code alone is ambiguous out of context ("BOE-SR-001" — and?), so the
      // accessible name says which direction it goes while the visible label
      // stays compact.
      aria-label={`${isPrevious ? 'Previous' : 'Next'} product: ${code}`}
      title={`${isPrevious ? 'Previous' : 'Next'} product (${code})`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        maxWidth: '46%',
        padding: '5px 10px',
        fontSize: '12px', fontWeight: 600,
        fontFamily: 'var(--font-body, DM Sans, sans-serif)',
        color: colors.secondary,
        background: colors.float,
        border: `1px solid ${colors.border}`,
        borderRadius: '7px',
        cursor: 'pointer',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {isPrevious && <ChevronLeft size={13} strokeWidth={2.2} style={{ flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{code}</span>
      {!isPrevious && <ChevronRight size={13} strokeWidth={2.2} style={{ flexShrink: 0 }} />}
    </button>
  )
}
