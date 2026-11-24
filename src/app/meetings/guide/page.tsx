'use client'

// How Meetings Work — the whole module, for somebody who has never opened it.
//
// WHERE IT LIVES AND WHY
// ----------------------
// Inside the Meetings module and nowhere else: this route sits under
// src/app/meetings, so it is behind MeetingsGuard (../layout.tsx) and inside
// MeetingsLayout, with the module's own sidebar and the header's one Back button.
// It is not on the dashboard, not in the global sidebar, and not in Tasks or
// Performance.
//
// WHAT IT NEEDS TO BE SEEN
// ------------------------
// Meetings module entry, and nothing more — the same 'view' grant an attendee
// holds. It reads no meeting, no order and no task, so there is nothing here for
// a permission to narrow: a view-only employee sees exactly what a manager sees.
// That is the reason it can be offered from the module header to everybody
// without widening a single grant.
//
// SHAPE OF THE PAGE
// -----------------
// Nine sections in the order somebody actually needs them: what the module is
// for, the three phases of a meeting, the two categories, how an issue arrives
// from a task, the life of an issue, a four-meeting worked example, how Meetings
// differs from Tasks, the pre-completion checklist, and the questions.
//
// Every sentence comes from ./guideContent, so guide.test.tsx can assert the
// claims against the constants and the migration the workflow runs on. Nothing
// technical appears: no table, policy or function name, and no developer word.
//
// The content itself — and how its diagrams stay readable and accessible — is in
// ./MeetingGuide.tsx.

import { useRouter } from 'next/navigation'
import { LoadingScreen } from '@/components/ui/atoms'
import { MeetingsLayout } from '@/components/layout/MeetingsLayout'
import { useMeetings } from '@/hooks/useMeetings'
import { MeetingGuide } from './MeetingGuide'

export default function HowMeetingsWorkPage() {
  const { profile, loading, signOut } = useMeetings()
  const router = useRouter()

  if (loading) return <LoadingScreen />

  return (
    <MeetingsLayout
      profile={profile}
      title="How Meetings Work"
      subtitle="What the Meeting module is for, and how an issue travels through it."
      onSignOut={signOut}
    >
      <MeetingGuide onBack={() => router.push('/meetings')} />
    </MeetingsLayout>
  )
}
