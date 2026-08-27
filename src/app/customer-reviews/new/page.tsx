'use client'

import { useRouter } from 'next/navigation'
import { LoadingScreen, EmptyState } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { RequestForm } from '@/components/customerReviews/RequestForm'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'

// Raising a request.
//
// Nothing exists in the database until Save, so there is no draft row left
// behind by somebody who opened this screen and changed their mind. The first
// save creates the draft and hands over to the request screen, which is where
// photographs, the status trail and the outreach actions live — a photograph
// cannot attach before the request has an id, because the storage policies read
// ownership out of that id.

export default function NewCustomerReviewRequestPage() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  if (loading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      canVerify={caps.canVerify}
      title="New review request"
      subtitle="Prepare an invitation for a customer you have actually worked with."
      onSignOut={signOut}
    >
      {/* A verifier without `use` reaches this URL legitimately — they can open
          the module — and must be told plainly rather than shown a form whose
          save the database will refuse. */}
      {!caps.canUse || !profile ? (
        <EmptyState
          message="You can verify review requests, but not raise them."
          hint="Ask an administrator for the Use permission if you need to run outreach yourself."
        />
      ) : (
        <RequestForm
          supabase={supabase}
          userId={profile.id}
          request={null}
          photos={[]}
          onPhotosChanged={() => {}}
          onToast={show}
          onCancel={() => router.push('/customer-reviews')}
          onSaved={(id, markedReady) => {
            show(markedReady ? 'Saved and marked Ready to Send' : 'Draft saved')
            router.push(`/customer-reviews/${id}`)
          }}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </CustomerReviewsLayout>
  )
}
