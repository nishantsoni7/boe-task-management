import ModuleGuard from '@/components/layout/ModuleGuard'

// Sample Tracking had NO route guard at all before this file existed:
// /samples checked only that a session existed, then fetched sample_dispatches
// on mount. An employee whose Sample Tracking module access was switched off in
// Access Control still got the full screen.
//
// The lifecycle actions (dispatch/receive/mark_lost/close) deliberately do NOT
// grant entry. Holding one of them with view = false is a dormant grant, which
// is the state Aditya is in and must stay in.
export default function SamplesLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="sample_tracking">{children}</ModuleGuard>
}
