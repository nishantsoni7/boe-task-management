'use client'

import { DepartmentsTab } from '@/components/controlCenter/DepartmentsTab'

// Control Center › People › Departments. It was ?tab=departments on the main page; the old address
// redirects here (next.config.ts). Admin gating is the Control Center layout's; every route the screen
// calls re-checks the caller.
export default function ControlCenterDepartmentsPage() {
  return <DepartmentsTab />
}
