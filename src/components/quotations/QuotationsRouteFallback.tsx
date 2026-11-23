'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { QuotationsLayout } from '@/components/layout/QuotationsLayout'
import { ModulePageSkeleton } from '@/components/layout/ModulePageSkeleton'
import { NO_ACCESS } from '@/lib/quotations/api'

// What /quotations/[id] shows BEFORE the builder has anything to say (src/app/quotations/[id]/loading.tsx): the
// Quotations shell with the page's own title and a skeleton in the body, as OrdersRouteFallback does for Orders. The
// same frame the builder draws while its quotation is on the way (BuilderScreen), so the hand-over does not flash.
//
// IT READS NOTHING and draws no action: what a person may do is decided once the page has asked the database.
export function QuotationsRouteFallback() {
  const router = useRouter()
  const signOut = useCallback(async () => {
    await createClient().auth.signOut()
    router.replace('/login')
  }, [router])
  return (
    <QuotationsLayout profile={null} access={NO_ACCESS} title="Quotation" onSignOut={signOut} contentMaxWidth={1360}>
      <ModulePageSkeleton variant="record" label="Loading quotation" />
    </QuotationsLayout>
  )
}
