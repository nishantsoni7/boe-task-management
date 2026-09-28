'use client'

// The last boundary: an error in the root layout itself (Providers included).
// It replaces the root layout, so it brings its own <html> and <body>, and the
// fallback uses inline styles only — nothing it needs can be the thing that failed.

import { RouteErrorView } from '@/components/errors/RouteErrorView'

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <title>BOE Operating System</title>
        <RouteErrorView error={error} retry={unstable_retry} />
      </body>
    </html>
  )
}
