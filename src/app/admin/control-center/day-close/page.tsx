'use client'

import { DayCloseLiveSetting } from '@/components/controlCenter/DayCloseLiveSetting'

// Control Center › Day Close & Scoreboard. Admin gating is the Control Center layout's; the route behind the
// switch (POST /api/day-close/members, action set_live) repeats it for every change.
export default function ControlCenterDayClosePage() {
  return <DayCloseLiveSetting />
}
