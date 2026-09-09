'use client'

import { WORKFLOW_STEPS, type WorkflowStep } from '@/lib/showroom/inquiryStage'
import { colors } from '@/lib/tokens'

// ── Where you are in the showroom flow ────────────────────────────────────────
//
// Three pages the customer moves through, drawn as three steps rather than left
// implicit in the URL. Deliberately small: a thin rail with three labels, not a
// wizard header — the screen underneath is the work, and the showroom flow is
// short enough that a big progress component would take more room than it earns.
//
// Which step is current is decided by `workflowStepForPath`, so the routes and
// the indicator can never drift apart.

export function WorkflowSteps({ current }: { current: WorkflowStep | null }) {
  if (!current) return null
  const currentIndex = WORKFLOW_STEPS.indexOf(current)

  return (
    <nav
      aria-label="Showroom progress"
      style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '16px' }}
    >
      {WORKFLOW_STEPS.map((step, i) => {
        const done   = i < currentIndex
        const active = i === currentIndex
        return (
          <div
            key={step}
            aria-current={active ? 'step' : undefined}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 }}
          >
            {/* The bar carries the state; the label just names it. A completed
                step stays filled so the customer can see how far they have come,
                not only where they are. */}
            <div style={{
              height: '3px', borderRadius: '2px',
              background: active ? '#1A2035' : done ? 'rgba(26,32,53,0.35)' : colors.float,
            }} />
            <span style={{
              fontSize: '10.5px',
              fontWeight: active ? 700 : 500,
              color: active ? colors.primary : colors.muted,
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {i + 1}. {step}
            </span>
          </div>
        )
      })}
    </nav>
  )
}
