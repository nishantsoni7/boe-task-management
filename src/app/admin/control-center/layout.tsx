'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useViewAs } from '@/hooks/useViewAs'
import { LoadingScreen } from '@/components/ui/atoms'

export default function ControlCenterLayout({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false)
  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, exitViewMode } = useViewAs()

  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }

      const { data: profile } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .single()

      if (!profile || profile.role !== 'admin') { router.replace('/dashboard'); return }
      if (viewAsUserId) { exitViewMode(); router.replace('/dashboard'); return }

      setAuthorized(true)
    }
    check()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!authorized) return <LoadingScreen />
  return <>{children}</>
}
