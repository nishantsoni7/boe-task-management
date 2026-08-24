'use client'

// ── A retired Received Payments route, forwarded ──────────────────────────────
//
// Both former child routes resolve to a view on the one list. The forward is a
// `replace`, not a `push`: a reader who presses Back should return to where they
// came from, not bounce through a route that immediately forwards again.
//
// EVERY OTHER PARAMETER SURVIVES. `?payment=` and `?action=` are how the Admin
// Action Queue and Finance notifications open a specific record, and a redirect
// that dropped them would turn a working deep link into a plain list — which
// looks like nothing happened.

import { useEffect, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import type { PaymentView } from '@/lib/finance/paymentClassification'

export function RetiredReceivedRoute({ view }: { view: PaymentView }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const forwarded = useRef(false)

  const href = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('view', view)
    return `/finance/received?${params.toString()}`
  }, [searchParams, view])

  useEffect(() => {
    if (forwarded.current) return
    forwarded.current = true
    router.replace(href)
  }, [href, router])

  return <LoadingScreen />
}
