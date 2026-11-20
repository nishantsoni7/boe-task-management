import { useEffect, useMemo, useRef } from 'react'
import type { QuoteLine } from '@/lib/quotations/math'

/** What a product row can ask the builder to do; the builder is told which product by its key. */
export type RowActions = {
  change: (key: string, patch: Partial<QuoteLine>) => void
  upload: (key: string, file: File | undefined) => void
  improve: (key: string) => void
  view: (key: string) => void
  remove: (key: string) => void
  move: (key: string, dir: -1 | 1) => void
  duplicate: (key: string) => void
}

/**
 * The same actions as ONE object that never changes, so a memoized product row is not drawn again just because the builder was
 * (typing in one product used to redraw all of them). Each call goes to the newest `actions`, read when the event happens, never
 * to the ones of an old render: `remove` keeps the lines it saw, for its Undo.
 */
export function useRowActions(actions: RowActions): RowActions {
  const live = useRef(actions)
  useEffect(() => { live.current = actions })
  return useMemo<RowActions>(() => ({
    change: (key, patch) => live.current.change(key, patch),
    upload: (key, file) => live.current.upload(key, file),
    improve: key => live.current.improve(key),
    view: key => live.current.view(key),
    remove: key => live.current.remove(key),
    move: (key, dir) => live.current.move(key, dir),
    duplicate: key => live.current.duplicate(key),
  }), [])
}
