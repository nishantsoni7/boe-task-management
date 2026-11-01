'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { SeoLayout } from '@/components/layout/SeoLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { fetchSeoData } from '@/lib/seo/api'
import { isSeoDataEmpty, type SeoData } from '@/lib/seo/report'
import { createClient } from '@/lib/supabase/client'

// Every SEO page: the shell, the one shared read, and the loading, error and empty states, so each screen only
// draws its own data.

type Props = {
  title: string
  subtitle?: string
  children: (data: SeoData) => React.ReactNode
}

export function SeoScreen({ title, subtitle, children }: Props) {
  const { profile } = usePermissionContext()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const query = useQuery({
    queryKey: ['seo', 'data'],
    queryFn: () => fetchSeoData(supabase),
    enabled: !!profile,
    staleTime: 5 * 60_000,
  })

  const signOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <SeoLayout profile={profile} title={title} subtitle={subtitle} onSignOut={signOut}>
      {query.isError ? (
        <div className="boe-empty">
          <p className="boe-empty-title">The SEO figures could not be loaded</p>
          <p>Check your connection and try again.</p>
          <button className="boe-btn boe-btn-secondary" onClick={() => query.refetch()}>Try again</button>
        </div>
      ) : !query.data ? (
        <LoadingScreen message="Loading SEO figures..." />
      ) : isSeoDataEmpty(query.data) ? (
        <div className="boe-empty">
          <p className="boe-empty-title">No SEO figures yet</p>
          <p>They appear here after the scheduled sessions send their first results.</p>
        </div>
      ) : children(query.data)}
    </SeoLayout>
  )
}
