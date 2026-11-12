// My Day (Day Close, owner 2026-11-12): plan the day by 10:30, close every item with proof or a reason,
// close the day before punching out. Self-service: /api/day-close/me takes the person from the token.

import { DayClosePage } from '@/components/dayClose/DayClosePage'
import { MyDayScreen } from '@/components/dayClose/MyDayScreen'

export default function MyDayPage() {
  return (
    <DayClosePage title="My Day" subtitle="Plan your day, close each item with proof, and close the day before you punch out.">
      <MyDayScreen />
    </DayClosePage>
  )
}
