'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ImageLibrary } from '@/components/customerReviews/ImageLibrary'
import { ProjectCityManager } from '@/components/customerReviews/ProjectCityManager'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'

// The project image library, as a workspace of its own.
//
// It used to live in a collapsed foldaway above the review list, where it was
// both easy to miss and — once opened — competing for the same screen as the
// queue. Managing a project's photographs is its own task; it gets its own page.
//
// Project name stays owned by ImageLibrary. City is project-level metadata,
// edited beside the library so every image inside one group inherits the same
// project/city reference without changing the stable upload path.
export function ImagesScreen() {
  const { supabase, profile, caps, loading, signOut } = useCustomerReviews()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    if (!caps.canVerify) router.replace('/customer-reviews')
  }, [loading, caps.canVerify, router])

  if (loading) return <LoadingScreen />

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Image Library"
      subtitle="One group is one project"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '900px' }}>
        <ImageLibrary supabase={supabase} />
        <ProjectCityManager supabase={supabase} />
      </div>
    </CustomerReviewsLayout>
  )
}
