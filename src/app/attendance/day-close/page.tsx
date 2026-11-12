// Day Close, Team Today (owner, 2026-11-12): everybody's plan, proof, punch-out and strikes for a day.
// Behind AttendanceGuard (administrators); /api/day-close/team checks again, and only the Day Close
// reviewer decides strikes.

import { DayClosePage } from '@/components/dayClose/DayClosePage'
import { TeamTodayScreen } from '@/components/dayClose/TeamTodayScreen'

export default function DayCloseTeamPage() {
  return (
    <DayClosePage title="Day Close" subtitle="Who planned, who closed, the proof, and the strikes to review.">
      <TeamTodayScreen />
    </DayClosePage>
  )
}
