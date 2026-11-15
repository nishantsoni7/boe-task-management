'use client'

import { SalesTeamTab } from '@/components/controlCenter/SalesTeamTab'

// Control Center › Sales › Sales team. It was ?tab=sales-team on the main page; the old address
// redirects here (next.config.ts).
export default function ControlCenterSalesTeamPage() {
  return <SalesTeamTab />
}
