'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen, EmptyState } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { RequestForm } from '@/components/customerReviews/RequestForm'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { canEditThisRequest } from '@/lib/permissions/customerReviewOutreach'
import {
  CUSTOMER_REVIEW_PHOTO_COLUMNS,
  CUSTOMER_REVIEW_REQUEST_COLUMNS,
  type CustomerReviewPhoto,
  type CustomerReviewRequest,
} from '@/lib/customerReviews/types'

// Editing an existing request.
//
// The same form as creating one, with photographs live — a photograph needs a
// saved request to belong to. The gate below is the browser's mirror of
// can_edit_customer_review_request(): the owner or an admin, and only while the
// request is still being prepared. A sent request is a record of something that
// reached a customer and is not rewritten afterwards.

export function EditRequestScreen({ requestId }: { requestId: string }) {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  const [request, setRequest] = useState<CustomerReviewRequest | null>(null)
  const [photos, setPhotos]   = useState<CustomerReviewPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const loadPhotos = useCallback(async () => {
    const { data } = await supabase
      .from('customer_review_request_photos')
      .select(CUSTOMER_REVIEW_PHOTO_COLUMNS)
      .eq('request_id', requestId)
      .order('uploaded_at', { ascending: true })
    setPhotos((data ?? []) as CustomerReviewPhoto[])
  }, [supabase, requestId])

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('customer_review_requests')
      .select(CUSTOMER_REVIEW_REQUEST_COLUMNS)
      .eq('id', requestId)
      .maybeSingle()

    // A request this person may not read comes back as no row rather than an
    // error — the SELECT policy filters it out — so "not available" is the
    // honest answer for both cases.
    if (error || !data) { setNotFound(true); setLoading(false); return }

    setRequest(data as CustomerReviewRequest)
    await loadPhotos()
    setLoading(false)
  }, [supabase, requestId, loadPhotos])

  useEffect(() => {
    if (authLoading) return
    const run = () => { void load() }
    run()
  }, [authLoading, load])

  if (authLoading || loading) return <LoadingScreen />

  const editable = !!request && canEditThisRequest(request, profile?.id ?? null, caps, profile?.role)

  return (
    <CustomerReviewsLayout
      profile={profile}
      canVerify={caps.canVerify}
      title={request ? `Edit — ${request.customer_name}` : 'Edit review request'}
      subtitle="Change the invitation before it goes out."
      onSignOut={signOut}
    >
      {notFound || !request ? (
        <EmptyState
          message="That request is not available."
          hint="It may have been removed, or it belongs to another employee."
        />
      ) : !editable || !profile ? (
        <EmptyState
          message="This request can no longer be edited."
          hint="A request that has been sent is a record of what the customer received, so its wording stays as it was."
        />
      ) : (
        <RequestForm
          supabase={supabase}
          userId={profile.id}
          request={request}
          photos={photos}
          onPhotosChanged={loadPhotos}
          onToast={show}
          onCancel={() => router.push(`/customer-reviews/${requestId}`)}
          onSaved={(id, markedReady) => {
            show(markedReady ? 'Saved and marked Ready to Send' : 'Changes saved')
            router.push(`/customer-reviews/${id}`)
          }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </CustomerReviewsLayout>
  )
}
