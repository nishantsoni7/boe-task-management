import { DatabaseZap, Hash, LayoutGrid, Monitor, ShieldCheck, TrendingUp, Users } from 'lucide-react'
import type { HubId } from '@/lib/controlCenter/navModel'

// One icon per area, shared by the sidebar and the Home directory so the two can never show an area differently.
export const HUB_ICON: Record<HubId, typeof Users> = {
  home: LayoutGrid, people: Users, access: ShieldCheck, orders: Hash, sales: TrendingUp, staff: Monitor, data: DatabaseZap,
}
