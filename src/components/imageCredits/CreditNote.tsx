'use client'

// The small line beside a picture button: what this press costs and what is left.
//
// Shows NOTHING while limits are off (the shipped state), so staff see no change until the founders turn limits
// on. It talks about credits only (see src/lib/imageCredits/note.ts). It is a courtesy; the press route is what
// enforces, so a failed lookup shows nothing and blocks nothing.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { creditNoteText, type CreditStatus } from '@/lib/imageCredits/note'

/** `refreshKey`: change it (for example when a press finishes) and the note reads the credits again. */
export function CreditNote({ cost, refreshKey }: { cost: number; refreshKey?: unknown }) {
  const [status, setStatus] = useState<CreditStatus | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { data } = await createClient().auth.getSession()
        const token = data.session?.access_token
        const res = await fetch('/api/image-credits/me', {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (res.ok && live) setStatus(await res.json() as CreditStatus)
      } catch { /* a courtesy line: nothing to show if it cannot load */ }
    })()
    return () => { live = false }
  }, [refreshKey])

  const note = creditNoteText(status, cost)
  if (!note) return null
  return (
    <p role="status" style={{ margin: '0 0 8px', fontSize: 12, color: note.warn ? colors.amber : colors.secondary }}>
      {note.text}
    </p>
  )
}
