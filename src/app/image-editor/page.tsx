'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ImageIcon, Upload, Wand2, Download, Loader2, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { ImageEditorLayout } from '@/components/layout/ImageEditorLayout'
import { colors } from '@/lib/tokens'
import {
  STUDIO_IMAGE_ACCEPT,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'
import {
  addFilesToQueue, pendingGenerationCount, nextWaiting, queueCounts,
  updateItem, removeItem, completedItems, canStartRun, resultFileName,
  MAX_QUEUE_SIZE, type QueueItem, type RejectedFile,
} from '@/lib/imageEditor/queue'
import { DOWNLOAD_FORMATS, type DownloadFormat } from '@/lib/imageEditor/downloadFormats'
import { VERIFICATION_HEADER, parseVerification } from '@/lib/imageEditor/verification'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import {
  deriveImageEditorCapabilities, IMAGE_EDITOR_MODULE_KEY,
} from '@/lib/permissions/imageEditor'
import { QueueList } from './QueueList'
import { ResultCard } from './ResultCard'

// Up to five photographs in, up to five catalogue images out.
//
// THE ONE THING THIS SCREEN IS CAREFUL ABOUT
// ------------------------------------------
// Each image is generated exactly once. Generate starts the run directly, and
// the protection against a second run is a ref rather than state, because state
// updates on the next render and two clicks in one frame would otherwise both
// start it. The run is sequential — one image at a time, in the order chosen.
//
// A failure never disturbs a success: results are kept on their own items as
// they arrive, so an image that fails fourth leaves the first three
// downloadable. Nothing is ever retried automatically; a retry is a person
// pressing a button.
//
// The screen says nothing about providers, requests, credits or cost. That is
// deliberate: a BOE employee is preparing a catalogue photograph, not
// administering an account.

type Phase =
  /** Choosing images, or looking at results. */
  | 'choosing'
  /** A run is in flight. */
  | 'running'

export default function ImageEditorPage() {
  // Entry is already decided by ModuleGuard in layout.tsx; what this reads is
  // the SECOND grant. `canGenerate` is false unless BOTH view and create are
  // effective, so the dormant-child state cannot light the button up.
  //
  // This hides a control. It does not authorize anything: POST
  // /api/image-editor/studio resolves the same two grants server-side before it
  // reads the upload, and refuses with 403 whatever the browser believes.
  const permissionContext = usePermissionContext()
  const { canGenerate } = deriveImageEditorCapabilities(
    permissionContext.role,
    permissionContext.permissionsByModule.get(IMAGE_EDITOR_MODULE_KEY) ?? [],
  )
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [items, setItems] = useState<QueueItem[]>([])
  const [rejected, setRejected] = useState<RejectedFile[]>([])
  const [format, setFormat] = useState<DownloadFormat>('png')
  const [phase, setPhase] = useState<Phase>('choosing')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  // The runner reads the queue through a ref: it updates state as it goes, and
  // state read inside the loop would be a render behind.
  const itemsRef = useRef<QueueItem[]>([])
  // The guard against a second run. A ref because state updates on the next
  // render, and two presses in the same frame would both see phase 'choosing'.
  const runningRef = useRef(false)
  const objectUrlsRef = useRef<string[]>([])

  const counts = queueCounts(items)
  const pending = pendingGenerationCount(items)
  const done = completedItems(items)
  const running = phase === 'running'

  useEffect(() => { itemsRef.current = items }, [items])

  // ── Auth ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data } = await supabase
        .from('users')
        .select(USER_PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .single()

      if (!active) return
      if (!data) { router.push('/login'); return }
      setProfile(data as UserProfile)
      setAuthLoading(false)
    }
    init()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [supabase, router])

  // ── Choosing ────────────────────────────────────────────────────────────────

  const addFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    if (runningRef.current) return

    const result = addFilesToQueue(
      itemsRef.current,
      Array.from(files),
      file => {
        const url = URL.createObjectURL(file)
        objectUrlsRef.current.push(url)
        return url
      },
      (file, index) => `${file.name}-${file.size}-${Date.now()}-${index}`,
    )

    setItems(result.items)
    setRejected(result.rejected)
    setError(null)
    setPhase('choosing')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const remove = useCallback((id: string) => {
    if (runningRef.current) return
    setItems(current => removeItem(current, id))
    setPhase('choosing')
  }, [])

  const startOver = useCallback(() => {
    if (runningRef.current) return
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current = []
    setItems([])
    setRejected([])
    setError(null)
    setPhase('choosing')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  // ── Generating ──────────────────────────────────────────────────────────────

  /** One image, one request. Returns the change to record on that item. */
  const generateOne = useCallback(async (item: QueueItem): Promise<Partial<QueueItem>> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push('/login'); return { status: 'failed', error: 'Your session ended. Sign in again.' } }

    // The photograph, and nothing else. There is no shape to choose: the
    // master is square, and a landscape or portrait crop of it is made later by
    // somebody who can see the picture.
    const form = new FormData()
    form.append('image', item.file)

    let res: Response
    try {
      res = await fetch('/api/image-editor/studio', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      })
    } catch {
      return { status: 'failed', error: 'Could not reach the server. Check your connection.' }
    }

    const payload = await res.json().catch(() => null)

    if (!res.ok) {
      return {
        status: 'failed',
        error: payload?.error ?? 'The studio image could not be generated.',
        // The route marks the failures that a second press cannot fix. Passing
        // it through is what stops an employee paying twice for the same answer.
        noRetry: payload?.noRetry === true,
      }
    }
    if (payload?.configured === false) {
      return {
        status: 'failed',
        error: 'The image service is not set up yet. Ask your administrator to configure it.',
        noRetry: true,
      }
    }
    const dataUrl: string | undefined = payload?.image?.dataUrl
    if (!dataUrl) {
      return { status: 'failed', error: 'The image service did not return an image.' }
    }

    return {
      status: 'done',
      error: undefined,
      noRetry: undefined,
      result: { dataUrl, mimeType: payload?.image?.mimeType ?? 'image/png' },
      // Whether anything actually verified this image. Unrecognised or missing
      // reads as undefined, and the card then says nothing either way — it
      // never invents a "verified".
      verification: parseVerification(res.headers.get(VERIFICATION_HEADER)),
    }
  }, [supabase, router])

  /**
   * Work the queue, one image at a time.
   *
   * Sequential on purpose: five at once is five times the load on the provider,
   * and a failure in the middle of that is far harder to report honestly than a
   * failure in a line.
   */
  const run = useCallback(async () => {
    if (runningRef.current) return
    if (!canStartRun(itemsRef.current)) return

    runningRef.current = true
    setPhase('running')
    setError(null)

    try {
      for (;;) {
        const next = nextWaiting(itemsRef.current)
        if (!next) break

        const startState = updateItem(itemsRef.current, next.id, { status: 'processing' })
        itemsRef.current = startState
        setItems(startState)

        const outcome = await generateOne(next)

        // Recorded against the item by id, so a result cannot land on the wrong
        // row and an earlier success cannot be overwritten.
        const endState = updateItem(itemsRef.current, next.id, outcome)
        itemsRef.current = endState
        setItems(endState)
      }
    } finally {
      runningRef.current = false
      setPhase('choosing')
    }
  }, [generateOne])

  const retry = useCallback((id: string) => {
    if (runningRef.current) return
    const back = updateItem(itemsRef.current, id, {
      status: 'waiting', error: undefined, noRetry: undefined, verification: undefined,
    })
    itemsRef.current = back
    setItems(back)
    void run()
  }, [run])

  // ── Downloading ─────────────────────────────────────────────────────────────

  const saveFile = useCallback((dataUrl: string, fileName: string) => {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [])

  /** The master is what the provider returned; anything else is a re-encode on
   *  the server, which costs nothing with the provider. */
  const download = useCallback(async (item: QueueItem) => {
    if (!item.result) return

    const masterIsPng = item.result.mimeType === 'image/png'
    if (format === 'png' && masterIsPng) {
      saveFile(item.result.dataUrl, resultFileName(item.name, 'png'))
      return
    }

    setDownloading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const blob = await (await fetch(item.result.dataUrl)).blob()
      const form = new FormData()
      form.append('image', blob, 'studio.png')
      form.append('format', format)

      const res = await fetch('/api/image-editor/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      })
      const payload = await res.json().catch(() => null)

      if (!res.ok || !payload?.image?.dataUrl) {
        setError(payload?.error ?? 'That image could not be converted for download.')
        return
      }
      saveFile(payload.image.dataUrl, resultFileName(item.name, payload.image.extension))
    } catch {
      setError('That image could not be converted for download.')
    } finally {
      setDownloading(false)
    }
  }, [format, saveFile, supabase, router])

  const downloadAll = useCallback(async () => {
    // One at a time, with a breath between: browsers refuse a burst of
    // simultaneous downloads, and a conversion is a server round trip each.
    for (const item of completedItems(itemsRef.current)) {
      await download(item)
      await new Promise(resolve => setTimeout(resolve, 350))
    }
  }, [download])

  if (authLoading) return <LoadingScreen message="Loading Image Editor..." />

  const canChoose = !running && items.length < MAX_QUEUE_SIZE

  return (
    <ImageEditorLayout
      profile={profile}
      title="Studio Image"
      subtitle="Turn factory photographs into catalogue-ready product images"
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '1040px' }}>

        {error && (
          <div className="boe-alert-red" style={{ marginBottom: '14px' }}>
            <span style={{ fontSize: '13px', color: '#C13030' }}>{error}</span>
          </div>
        )}

        {rejected.length > 0 && (
          <div className="boe-alert-amber" style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', color: '#8A5A12' }}>
              {rejected.map(r => (
                <div key={r.name}>
                  <strong>{r.name}</strong> was not added — {r.reason}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Choose ──────────────────────────────────────────────────────── */}
        {canChoose && (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: '8px', padding: items.length > 0 ? '20px' : '44px 20px', marginBottom: '14px',
              background: dragging ? colors.hover : colors.raised,
              border: `1.5px dashed ${dragging ? colors.borderMed : colors.borderSoft}`,
              borderRadius: '10px', cursor: 'pointer', textAlign: 'center',
            }}
          >
            <div style={{
              width: 40, height: 40, borderRadius: '11px',
              background: 'rgba(232,160,48,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Upload size={18} color={colors.amber} strokeWidth={1.8} />
            </div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
              {items.length === 0 ? 'Choose up to five product photographs' : 'Add another photograph'}
            </div>
            <div style={{ fontSize: '12px', color: colors.tertiary, maxWidth: '360px' }}>
              Tap to choose, or drag them here. JPG, PNG or WebP, up to {MAX_SOURCE_IMAGE_LABEL} each.
            </div>
          </div>
        )}

        <QueueList items={items} locked={running} onRemove={remove} />

        {/* ── Output shape ────────────────────────────────────────────────── */}
        {/* ── Generate ────────────────────────────────────────────────────── */}
        {/* Somebody with View but not Use gets a sentence, not a dead button.
            A disabled control with no explanation reads as a fault in the
            product; this says what is missing and who can grant it. The button
            is not rendered at all, so there is nothing to click and no generic
            failure to misread. The API refuses independently — this is the
            explanation, never the boundary. */}
        {pending > 0 && !running && !canGenerate && (
          <div className="boe-alert-amber" style={{
            display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '14px',
          }}>
            <Lock size={14} strokeWidth={2} color={colors.amber} style={{ flexShrink: 0, marginTop: '1px' }} />
            <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.45 }}>
              <strong style={{ color: colors.primary }}>Use access is not enabled for your account.</strong>
              {' '}You can open the Image Editor and look at earlier results, but not generate
              new studio images. Ask an administrator to enable <em>Use</em> for the Image Editor.
            </div>
          </div>
        )}

        {pending > 0 && !running && canGenerate && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <button className="boe-btn boe-btn-primary" onClick={() => { void run() }} disabled={running}>
              <Wand2 size={13} strokeWidth={2} />
              {pending === 1 ? 'Generate Studio Image' : `Generate ${pending} Studio Images`}
            </button>
          </div>
        )}

        {/* ── Progress ────────────────────────────────────────────────────── */}
        {running && (
          <div className="boe-card" style={{ padding: '14px', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Loader2 size={16} strokeWidth={2} color={colors.blue} />
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                Processing {counts.position} of {counts.total}
              </div>
              <div style={{ fontSize: '12px', color: colors.tertiary }}>
                One image at a time. Keep this page open — finished images appear below as they arrive.
              </div>
            </div>
          </div>
        )}

        {/* ── Results ─────────────────────────────────────────────────────── */}
        {(counts.done > 0 || counts.failed > 0) && (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              marginBottom: '10px',
            }}>
              <div style={{
                fontSize: '11px', fontWeight: 600, color: colors.tertiary,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {counts.done} completed{counts.failed > 0 ? `, ${counts.failed} failed` : ''}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                <label htmlFor="download-format" style={{ fontSize: '12px', color: colors.tertiary }}>
                  Download as
                </label>
                <select
                  id="download-format"
                  className="boe-input"
                  value={format}
                  onChange={e => setFormat(e.target.value as DownloadFormat)}
                  style={{ width: 'auto', padding: '5px 8px', fontSize: '12px', cursor: 'pointer' }}
                >
                  {DOWNLOAD_FORMATS.map(f => (
                    <option key={f} value={f}>{f.toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: '12px',
            }}>
              {items
                .filter(item => item.status === 'done' || item.status === 'failed')
                .map(item => (
                  <ResultCard
                    key={item.id}
                    item={item}
                    busy={running || downloading}
                    onDownload={download}
                    onRemove={remove}
                    onRetry={retry}
                  />
                ))}
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
              {done.length > 1 && (
                <button
                  className="boe-btn boe-btn-primary"
                  onClick={() => { void downloadAll() }}
                  disabled={running || downloading}
                >
                  <Download size={13} strokeWidth={2} />
                  Download all {done.length}
                </button>
              )}
              <button className="boe-btn boe-btn-ghost" onClick={startOver} disabled={running}>
                <ImageIcon size={13} strokeWidth={2} />
                Edit another set
              </button>
            </div>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={STUDIO_IMAGE_ACCEPT}
          style={{ display: 'none' }}
          onChange={e => addFiles(e.target.files)}
        />
      </div>
    </ImageEditorLayout>
  )
}
