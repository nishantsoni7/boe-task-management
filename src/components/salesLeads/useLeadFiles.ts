'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ATTACHMENT_UPLOAD_CONCURRENCY, compressImageFile, mapWithConcurrency } from '@/lib/attachment-utils'
import {
  canPreview, fileKey, formatBytes, LEAD_FILE_MAX_BYTES, LEAD_FILES_BUCKET, leadFilePath, leadFileType, refusalLine, sortIncoming,
  uploadErrorWords,
} from '@/lib/salesLeads/files'
import type { LeadWork } from './useLeadWork'

// The files a person is putting on an update (owner, 2026-11-15). The moment a file is picked, dropped or pasted it is queued and
// uploads in the background, so the update is only waiting on what is still in flight when Post is pressed. The object goes
// into the bucket first; the database row is written by add_sales_lead_comment together with the update, so an upload that is
// never posted is invisible in the app. This hook takes it away again: when the person removes the file, and when the box goes
// away with its lead or the popup closes. (A tab closed mid-way leaves an object nobody can see: accepted, as for tasks.)

export type QueuedFile = {
  id: string
  name: string
  size: number
  type: string
  status: 'uploading' | 'ready' | 'failed'
  /** The object's path in the bucket, once it has landed. */
  path: string | null
  error: string | null
  /** A picture the browser can draw, from the file itself, until it is posted. */
  preview: string | null
  /** What was picked, kept so a failed upload can be tried again without picking it again. */
  source: File
}

export function useLeadFiles(supabase: LeadWork['supabase'], leadId: string) {
  const [items, setItems] = useState<QueuedFile[]>([])
  const [refusal, setRefusal] = useState('')
  // What the unmount cleanup and the callbacks read without being re-made on every change.
  const latest = useRef<QueuedFile[]>([])
  useEffect(() => { latest.current = items }, [items])
  /** Removed while still uploading: the upload takes its own object away when it lands. */
  const gone = useRef(new Set<string>())
  const bucket = useCallback(() => supabase.storage.from(LEAD_FILES_BUCKET), [supabase])

  const patch = useCallback((id: string, change: Partial<QueuedFile>) => {
    setItems(list => list.map(x => (x.id === id ? { ...x, ...change } : x)))
  }, [])

  const upload = useCallback(async (id: string, original: File) => {
    try {
      const type = leadFileType(original)
      if (!type) throw new Error('not supported')
      // A photo is made smaller first; anything else goes as it is.
      const file = await compressImageFile(original)
      if (file.size > LEAD_FILE_MAX_BYTES) { patch(id, { status: 'failed', error: `This is over ${formatBytes(LEAD_FILE_MAX_BYTES)}, even made smaller.` }); return }
      const path = leadFilePath(leadId, original.name, crypto.randomUUID().slice(0, 8))
      const { error } = await bucket().upload(path, file, { contentType: type, upsert: false })
      if (error) throw error
      if (gone.current.has(id)) { void bucket().remove([path]); return }
      patch(id, { status: 'ready', path, size: file.size })
    } catch (e) {
      if (!gone.current.has(id)) patch(id, { status: 'failed', error: uploadErrorWords(e as { message?: string }) })
    }
  }, [bucket, leadId, patch])

  const add = useCallback((picked: readonly File[]) => {
    const have = latest.current
    const { take, refused } = sortIncoming(picked, have.length, new Set(have.map(x => fileKey(x.source))))
    setRefusal(refusalLine(refused))
    if (take.length === 0) return
    const fresh: QueuedFile[] = take.map(f => {
      const type = leadFileType(f) ?? f.type
      return {
        id: crypto.randomUUID(), name: f.name || 'File', size: f.size, type, status: 'uploading', path: null, error: null,
        preview: canPreview(type) ? URL.createObjectURL(f) : null, source: f,
      }
    })
    latest.current = [...have, ...fresh]
    setItems(latest.current)
    void mapWithConcurrency(fresh, ATTACHMENT_UPLOAD_CONCURRENCY, it => upload(it.id, it.source))
  }, [upload])

  const remove = useCallback((id: string) => {
    const it = latest.current.find(x => x.id === id)
    if (!it) return
    if (it.status === 'uploading') gone.current.add(id)
    if (it.path) void bucket().remove([it.path])
    if (it.preview) URL.revokeObjectURL(it.preview)
    latest.current = latest.current.filter(x => x.id !== id)
    setItems(latest.current)
  }, [bucket])

  const retry = useCallback((id: string) => {
    const it = latest.current.find(x => x.id === id)
    if (!it || it.status !== 'failed') return
    patch(id, { status: 'uploading', error: null })
    void upload(id, it.source)
  }, [patch, upload])

  /** The update was saved with these files: they belong to it now, so nothing is taken away. */
  const finish = useCallback(() => {
    for (const x of latest.current) if (x.preview) URL.revokeObjectURL(x.preview)
    latest.current = []
    setItems([])
    setRefusal('')
  }, [])

  // The box goes away with its lead or with the popup: what was never posted is taken out of the bucket. Only an unmount runs
  // this (never a re-render), so the client is read from a ref.
  const client = useRef(supabase)
  useEffect(() => { client.current = supabase }, [supabase])
  useEffect(() => {
    const goneNow = gone.current
    return () => {
      const pending = latest.current
      const paths = pending.filter(x => x.path).map(x => x.path as string)
      for (const x of pending) {
        if (x.status === 'uploading') goneNow.add(x.id)
        if (x.preview) URL.revokeObjectURL(x.preview)
      }
      if (paths.length > 0) void client.current.storage.from(LEAD_FILES_BUCKET).remove(paths)
    }
  }, [])

  const ready = items.filter(x => x.status === 'ready' && x.path).map(x => ({ path: x.path as string, name: x.name }))
  return {
    items, refusal, add, remove, retry, finish, dismissRefusal: () => setRefusal(''),
    uploading: items.some(x => x.status === 'uploading'), failed: items.some(x => x.status === 'failed'), ready,
  }
}
