'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'

// Employee Records moved into the Control Center.
//
// This screen used to be the second half of employee administration: the
// Control Center could change somebody's department and nothing else, and this
// page could change everything else. Both are now one screen at
// /admin/control-center/people, which does what this page did plus the
// department change, in a single dialog per person.
//
// The ROUTE stays. It is bookmarked, it is the `employee_records` module's
// declared entry (see layout.tsx and src/lib/permissions/moduleParentGate.test.ts),
// and its ModuleGuard still runs in front of this redirect — so somebody whose
// Employee Records access is switched off is refused here exactly as before,
// rather than being bounced onward. Nothing else about the module, its
// permissions or its API routes changed.
export default function AdminMembersPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/admin/control-center/people')
  }, [router])

  return <LoadingScreen />
}
