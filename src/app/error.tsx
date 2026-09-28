'use client'

// The error boundary for every route below the root layout. The root layout
// (and so Providers) stays mounted; only the failed page is replaced.
// See src/lib/errors/routeError.ts.

import { RouteErrorView } from '@/components/errors/RouteErrorView'

export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return <RouteErrorView error={error} retry={unstable_retry} />
}
