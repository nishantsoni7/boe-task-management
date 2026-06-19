'use client'

import { ViewAsProvider } from '@/contexts/ViewAsContext'
import { RefreshProvider } from '@/contexts/RefreshContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per browser session — created once, never recreated on re-render
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is considered fresh for 30 seconds — no refetch on window focus within this window
            staleTime: 30 * 1000,
            // Keep unused cache for 5 minutes so back-navigation feels instant
            gcTime: 5 * 60 * 1000,
            // Retry once on failure (network blip), not 3 times (default)
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <RefreshProvider>
        <ViewAsProvider>{children}</ViewAsProvider>
      </RefreshProvider>
    </QueryClientProvider>
  )
}
