import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'

// The route-level loading boundary for every Control Center section.
//
// Next nests this INSIDE layout.tsx and wraps page.tsx — and every nested
// segment below it — in a <Suspense> boundary with this as the fallback. So
// while a section's chunk is still arriving, the sidebar and header stay
// exactly where they are and only the content pane shows the skeleton. It also
// lets Next prefetch the loading state for these dynamic routes, which is what
// makes a sidebar click respond immediately instead of after a server round trip.
export default function ControlCenterLoading() {
  return <ControlCenterSkeleton />
}
