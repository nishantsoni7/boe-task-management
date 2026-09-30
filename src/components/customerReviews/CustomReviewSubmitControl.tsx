'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  SUBMIT_LOADING_REASON,
  type SubmitAvailability,
} from '@/lib/customerReviews/submitAvailability'

// ONE SHARED SUBMIT ACTION for the Reviews landing page. The Custom Reviews
// section owns the form and the allowance; it publishes both here, and the page
// header reads them. There is no DOM lookup or forwarded click: the header button
// calls the same open() the section's own button calls, and both are disabled by
// the same availability.

type Control = { availability: SubmitAvailability; open: () => void }

const LOADING: Control = { availability: { status: 'loading', reason: SUBMIT_LOADING_REASON }, open: () => {} }

const Ctx = createContext<{ control: Control; publish: (c: Control) => void } | null>(null)

export function SubmitControlProvider({ children }: { children: React.ReactNode }) {
  const [control, setControl] = useState<Control>(LOADING)
  const value = useMemo(() => ({ control, publish: setControl }), [control])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Read by the header. Loading until the section has published. */
export function useSubmitControl(): Control {
  return useContext(Ctx)?.control ?? LOADING
}

/** Called by the section that owns the form. `open` must be stable. */
export function usePublishSubmitControl(availability: SubmitAvailability, open: () => void) {
  const publish = useContext(Ctx)?.publish
  const { status, reason } = availability
  useEffect(() => {
    publish?.({ availability: { status, reason } as SubmitAvailability, open })
  }, [publish, status, reason, open])
}

export function SubmitReviewHeaderButton() {
  const { availability, open } = useSubmitControl()
  const ready = availability.status === 'ready'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 }}>
      {!ready && (
        <span
          id="header-submit-reason"
          role={availability.status === 'error' ? 'alert' : 'note'}
          style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.4, maxWidth: 280, color: availability.status === 'loading' ? '#6B7384' : availability.status === 'limit' ? '#92400E' : '#B91C1C' }}
        >
          {availability.reason}
        </span>
      )}
      <button
        type="button"
        className="boe-btn boe-btn-primary"
        disabled={!ready}
        aria-describedby={ready ? undefined : 'header-submit-reason'}
        onClick={open}
        style={{ minHeight: '44px', padding: '8px 14px', fontSize: '13px' }}
      >
        Submit review
      </button>
    </div>
  )
}
