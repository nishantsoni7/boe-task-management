'use client'

import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'

// ── /finance/received — redirect only ─────────────────────────────────────────
// Received Payments is no longer one list with an internal tab strip; it is two
// sibling routes (linked / unlinked). This route keeps no table of its own — it
// resolves where the caller belongs and replaces itself with that page.
//
// Existing deep links still arrive here with `?payment=…&action=link|edit`
// (the Admin Action Queue, the Order Requests details modal, and Finance
// notifications via getNotificationMeta). Rather than have each caller guess
// which of the two pages currently holds the row, this looks the linkage up and
// forwards the query string untouched, so every one of those links keeps
// working and keeps opening the same modal it always did.

export default function ReceivedPaymentsRedirectPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <ReceivedPaymentsRedirect />
    </Suspense>
  )
}

function ReceivedPaymentsRedirect() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const supabase     = useMemo(() => createClient(), [])
  const resolved     = useRef(false)

  useEffect(() => {
    if (resolved.current) return
    resolved.current = true

    const query  = searchParams.toString()
    const suffix = query ? `?${query}` : ''
    const paymentId = searchParams.get('payment')

    // Plain navigation: Linked Payments is the default child route.
    if (!paymentId) { router.replace(`/finance/received/linked${suffix}`); return }

    const resolve = async () => {
      const { data } = await supabase
        .from('finance_payment_requests')
        .select('order_id, order_request_id')
        .eq('id', paymentId)
        .maybeSingle()

      // Suspense only when both linkage columns are empty. A row that is
      // missing or not readable under RLS falls through to Linked, the default,
      // which simply highlights nothing — never an error page.
      const isSuspense = !!data && !data.order_id && !data.order_request_id
      router.replace(`/finance/received/${isSuspense ? 'unlinked' : 'linked'}${suffix}`)
    }
    resolve()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <LoadingScreen />
}
