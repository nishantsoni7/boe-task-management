'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, ImageIcon, RotateCcw, Upload, Wand2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import type { UserProfile } from '@/lib/types'
import { LoadingScreen } from '@/components/ui/atoms'
import { ImageEditorLayout } from '@/components/layout/ImageEditorLayout'
import { colors } from '@/lib/tokens'
import {
  validateSourceImage,
  STUDIO_IMAGE_ACCEPT,
  MAX_SOURCE_IMAGE_LABEL,
} from '@/lib/imageEditor/validation'

// One photograph in, one catalogue image out.
//
// The screen is a four-state machine and nothing else — choose, generate, wait,
// compare — because every control that is not one of those four is a control an
// employee has to read before they can do the one thing this page is for.
//
//   choose      empty upload area
//   ready       the photograph they picked, and the one button
//   working     the same photograph, greyed, with a progress line
//   done        original beside result, download, start again
//
// An error does not become a fifth state: it sits above whichever state the
// employee was in, so their photograph is still selected and Try Again is one
// tap. Nothing is uploaded until they press Generate, and nothing is kept
// afterwards — the result lives in this component's state as a data URL and is
// gone when the page is closed.

type Phase = 'choose' | 'ready' | 'working' | 'done'

export default function ImageEditorPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [file, setFile]             = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [resultUrl, setResultUrl]   = useState<string | null>(null)
  const [phase, setPhase]           = useState<Phase>('choose')
  const [error, setError]           = useState<string | null>(null)
  // A quality refusal is not a failure to retry — the same photograph will be
  // refused again. It offers a different photograph instead.
  const [qualityIssue, setQualityIssue] = useState(false)
  const [dragging, setDragging]     = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  // Object URLs are revoked by hand; the browser holds the blob alive until then.
  const objectUrlRef = useRef<string | null>(null)

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
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [supabase, router])

  // ── Choosing a photograph ───────────────────────────────────────────────────

  const selectFile = useCallback((chosen: File | null | undefined) => {
    // The same validator the route runs. Catching it here saves an upload; the
    // decision that counts is still made server-side.
    const validation = validateSourceImage(chosen ?? null)
    if (!validation.ok) {
      setError(validation.error)
      setQualityIssue(false)
      return
    }

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(chosen as File)
    objectUrlRef.current = url

    setFile(chosen as File)
    setOriginalUrl(url)
    setResultUrl(null)
    setError(null)
    setQualityIssue(false)
    setPhase('ready')
  }, [])

  const reset = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = null
    setFile(null)
    setOriginalUrl(null)
    setResultUrl(null)
    setError(null)
    setQualityIssue(false)
    setPhase('choose')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    selectFile(e.dataTransfer.files?.[0])
  }, [selectFile])

  // ── Generating ──────────────────────────────────────────────────────────────

  const generate = useCallback(async () => {
    if (!file) return
    setPhase('working')
    setError(null)
    setQualityIssue(false)
    setResultUrl(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const form = new FormData()
      form.append('image', file)

      const res = await fetch('/api/image-editor/studio', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      })

      const payload = await res.json().catch(() => null)

      if (!res.ok) {
        setError(payload?.error ?? 'The studio image could not be generated. Please try again.')
        // The server measured the product as too small or too soft for a sharp
        // catalogue image. Retrying cannot change that; a different photograph
        // can.
        setQualityIssue(payload?.quality === true)
        setPhase('ready')
        return
      }

      // No key configured. Said plainly rather than dressed up as a failure the
      // employee could fix by retrying.
      if (payload?.configured === false) {
        setError('The image service is not set up yet. Ask your administrator to configure it.')
        setPhase('ready')
        return
      }

      const dataUrl: string | undefined = payload?.image?.dataUrl
      if (!dataUrl) {
        setError('The studio image could not be generated. Please try again.')
        setPhase('ready')
        return
      }

      setResultUrl(dataUrl)
      setPhase('done')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setPhase('ready')
    }
  }, [file, supabase, router])

  const download = useCallback(() => {
    if (!resultUrl) return
    const base = (file?.name ?? 'product').replace(/\.[^.]+$/, '')
    const ext = resultUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png'
    const a = document.createElement('a')
    a.href = resultUrl
    a.download = `${base}-studio.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [resultUrl, file])

  if (authLoading) return <LoadingScreen message="Loading Image Editor..." />

  const working = phase === 'working'

  return (
    <ImageEditorLayout
      profile={profile}
      title="Studio Image"
      subtitle="Turn one factory photograph into one catalogue-ready product image"
      onSignOut={signOut}
    >
      <div style={{ maxWidth: '980px' }}>

        {error && (
          <div
            className={qualityIssue ? 'boe-alert-amber' : 'boe-alert-red'}
            style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}
          >
            <span style={{
              fontSize: '13px', flex: 1, minWidth: '200px',
              color: qualityIssue ? '#8A5A12' : '#C13030',
            }}>
              {error}
            </span>
            {qualityIssue ? (
              <button className="boe-btn boe-btn-ghost" onClick={() => inputRef.current?.click()}>
                <ImageIcon size={13} strokeWidth={2} />
                Choose a different photo
              </button>
            ) : file && phase !== 'working' && (
              <button className="boe-btn boe-btn-danger" onClick={generate}>
                <RotateCcw size={13} strokeWidth={2} />
                Try Again
              </button>
            )}
          </div>
        )}

        {/* ── Choose ──────────────────────────────────────────────────────── */}
        {phase === 'choose' && (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click() }}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: '10px',
              padding: '48px 20px',
              background: dragging ? colors.hover : colors.raised,
              border: `1.5px dashed ${dragging ? colors.borderMed : colors.borderSoft}`,
              borderRadius: '10px',
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            <div style={{
              width: 46, height: 46, borderRadius: '12px',
              background: 'rgba(232,160,48,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Upload size={20} color={colors.amber} strokeWidth={1.8} />
            </div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: colors.primary }}>
              Upload a product photograph
            </div>
            <div style={{ fontSize: '12px', color: colors.tertiary, maxWidth: '340px' }}>
              Tap to choose a photo, or drag one here. JPG, PNG or WebP, up to {MAX_SOURCE_IMAGE_LABEL}.
            </div>
          </div>
        )}

        {/* ── Ready / working ─────────────────────────────────────────────── */}
        {(phase === 'ready' || working) && originalUrl && (
          <div className="boe-card" style={{ padding: '14px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: colors.tertiary, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
              Your photograph
            </div>

            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={originalUrl}
              alt="Uploaded product photograph"
              style={{
                width: '100%', maxHeight: '46vh', objectFit: 'contain',
                borderRadius: '8px', background: colors.float,
                opacity: working ? 0.55 : 1,
                transition: 'opacity 0.2s ease',
              }}
            />

            {working ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' }}>
                <div className="boe-loading-spinner" style={{ width: 16, height: 16, margin: 0 }} />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                    Generating the studio image…
                  </div>
                  <div style={{ fontSize: '12px', color: colors.tertiary }}>
                    This usually takes under a minute. Keep this page open.
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
                <button className="boe-btn boe-btn-primary" onClick={generate}>
                  <Wand2 size={13} strokeWidth={2} />
                  Generate Studio Image
                </button>
                <button className="boe-btn boe-btn-ghost" onClick={() => inputRef.current?.click()}>
                  Choose a different photo
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Done: original vs result ────────────────────────────────────── */}
        {phase === 'done' && originalUrl && resultUrl && (
          <>
            <div style={{
              display: 'grid',
              // Two panels side by side on a desktop, stacked on a phone, with no
              // media query to keep in step with the sidebar breakpoint.
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '12px',
            }}>
              <ComparePanel label="Original" src={originalUrl} alt="Uploaded product photograph" />
              <ComparePanel label="Studio image" src={resultUrl} alt="Generated studio product image" accent />
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
              <button className="boe-btn boe-btn-primary" onClick={download}>
                <Download size={13} strokeWidth={2} />
                Download Image
              </button>
              <button className="boe-btn boe-btn-ghost" onClick={reset}>
                <ImageIcon size={13} strokeWidth={2} />
                Edit Another Image
              </button>
            </div>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={STUDIO_IMAGE_ACCEPT}
          style={{ display: 'none' }}
          onChange={e => selectFile(e.target.files?.[0])}
        />
      </div>
    </ImageEditorLayout>
  )
}

// ─── Comparison panel ────────────────────────────────────────────────────────
// Both sides render the same way and at the same height, because a comparison
// where one picture is bigger is not a comparison.

function ComparePanel({ label, src, alt, accent }: {
  label: string
  src: string
  alt: string
  accent?: boolean
}) {
  return (
    <div className="boe-card" style={{ padding: '12px' }}>
      <div style={{
        fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '8px',
        color: accent ? colors.amber : colors.tertiary,
      }}>
        {label}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        style={{
          width: '100%', aspectRatio: '1 / 1', objectFit: 'contain',
          borderRadius: '8px', background: colors.float,
        }}
      />
    </div>
  )
}
