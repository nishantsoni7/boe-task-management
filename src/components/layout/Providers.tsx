'use client'

import { ViewAsProvider } from '@/contexts/ViewAsContext'
import { RefreshProvider } from '@/contexts/RefreshContext'
import type { ReactNode } from 'react'

export function Providers({ children }: { children: ReactNode }) {
  return (
    <RefreshProvider>
      <ViewAsProvider>{children}</ViewAsProvider>
    </RefreshProvider>
  )
}
