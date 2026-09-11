import { LoadingScreen } from '@/components/ui/atoms'

// The route-level loading boundary for a single task.
//
// /tasks/[id] is a dynamic route, and Next prefetches a dynamic route only down
// to its nearest loading.js. Without this file a prefetch carried nothing the
// click could use, so every open — the drawer's View Task Page, a My Tasks row,
// a notification — waited on a server round trip before the URL even changed,
// with nothing on screen to say the click had landed. With it the fallback is
// prefetched and the navigation commits at once, showing the same spinner the
// page itself shows while its data loads.
export default function TaskDetailLoading() {
  return <LoadingScreen />
}
