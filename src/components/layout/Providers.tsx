'use client'

import { ViewAsProvider } from '@/contexts/ViewAsContext'
import type { ReactNode } from 'react'

export function Providers({ children }: { children: ReactNode }) {
  return <ViewAsProvider>{children}</ViewAsProvider>
}
