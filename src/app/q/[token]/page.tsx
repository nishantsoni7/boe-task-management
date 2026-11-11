import { Suspense } from 'react'
import type { Metadata } from 'next'
import { LoadingScreen } from '@/components/ui/atoms'
import { PublicScreen } from '@/components/quotations/DocumentScreens'

// The client's link. Public on purpose (no session): quotation_public(token) returns only client-safe fields.
export const metadata: Metadata = { title: 'Quotation · Best of Exports', robots: { index: false, follow: false } }

export default function ClientQuotationPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PublicScreen />
    </Suspense>
  )
}
