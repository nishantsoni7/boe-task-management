'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { colors, font } from '@/lib/tokens'

type UiState = 'init' | 'no-session' | 'starting' | 'live' | 'no-detector' | 'invalid' | 'navigating'

export default function ScanPage() {
  const [uiState,  setUiState]  = useState<UiState>('init')
  const [errorMsg, setErrorMsg] = useState('')
  const videoRef  = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef    = useRef<number | null>(null)
  const router    = useRouter()

  const stopCamera = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }

  const handleScannedValue = useCallback((raw: string) => {
    stopCamera()
    const match = raw.match(/\/showroom\/product\/([A-Za-z0-9\-_]+)/i)
    if (!match) {
      setErrorMsg('This is not a valid BOE product QR.')
      setUiState('invalid')
      return
    }
    setUiState('navigating')
    router.push(`/showroom/product/${encodeURIComponent(match[1].toUpperCase())}`)
  }, [router])

  useEffect(() => {
    const sp       = localStorage.getItem('boe_sp')
    const customer = localStorage.getItem('boe_customer')
    if (!sp || !customer) { setUiState('no-session'); return }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BD = (window as any).BarcodeDetector
    if (!BD) { setUiState('no-detector'); return }

    setUiState('starting')
    let mounted = true
    const detector = new BD({ formats: ['qr_code'] })

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream: MediaStream) => {
        if (!mounted) { stream.getTracks().forEach((t: MediaStreamTrack) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().then(() => { if (mounted) setUiState('live') })
        }
        const tick = async () => {
          if (!mounted || !videoRef.current || !streamRef.current) return
          try {
            const codes = await detector.detect(videoRef.current)
            if (codes.length > 0 && mounted) {
              mounted = false
              handleScannedValue(codes[0].rawValue)
              return
            }
          } catch { /* ignore per-frame decode errors */ }
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      })
      .catch(() => { if (mounted) setUiState('no-detector') })

    return () => { mounted = false; stopCamera() }
  }, [handleScannedValue])

  return (
    <Shell onBack={() => { stopCamera(); router.push('/showroom/project-list') }}>
      {uiState === 'init' || uiState === 'starting' ? (
        <Centered>
          <div style={{ fontSize: '14px', color: colors.muted }}>Starting camera…</div>
        </Centered>
      ) : uiState === 'no-session' ? (
        <Centered>
          <IconBox emoji="⚠" color="rgba(232,160,48,0.10)" />
          <Title>Session Expired</Title>
          <Subtitle>Please scan your salesperson&apos;s QR code to start a new session.</Subtitle>
          <PrimaryBtn onClick={() => router.push('/showroom/join')}>
            Go to Salesperson QR
          </PrimaryBtn>
        </Centered>
      ) : uiState === 'live' ? (
        <div>
          <div style={{
            position: 'relative', width: '100%', borderRadius: '12px',
            overflow: 'hidden', background: '#000', aspectRatio: '1/1',
            marginBottom: '16px',
          }}>
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {/* Viewfinder overlay */}
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none',
            }}>
              <div style={{
                width: '60%', aspectRatio: '1/1',
                border: '2.5px solid rgba(255,255,255,0.8)',
                borderRadius: '12px',
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
              }} />
            </div>
          </div>
          <div style={{ textAlign: 'center', fontSize: '13px', color: colors.tertiary }}>
            Point the camera at a product QR label
          </div>
        </div>
      ) : uiState === 'navigating' ? (
        <Centered>
          <div style={{ fontSize: '14px', color: colors.muted }}>Loading product…</div>
        </Centered>
      ) : uiState === 'invalid' ? (
        <Centered>
          <IconBox emoji="✕" color="rgba(217,79,79,0.08)" />
          <Title>Invalid QR</Title>
          <Subtitle>{errorMsg}</Subtitle>
          <PrimaryBtn onClick={() => { setUiState('starting'); setErrorMsg(''); }}>
            Try Again
          </PrimaryBtn>
        </Centered>
      ) : (
        /* no-detector: BarcodeDetector unavailable (iOS Safari, older browsers) */
        <Centered>
          <div style={{ fontSize: '36px', marginBottom: '4px' }}>📷</div>
          <Title>Use Your Camera App</Title>
          <div style={{
            fontSize: '13px', color: colors.tertiary, lineHeight: 1.7,
            textAlign: 'center', maxWidth: '280px',
          }}>
            Open your phone&apos;s camera and point it at any product QR label in the showroom.
            The product page will open automatically.
          </div>
          <div style={{
            marginTop: '16px',
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '10px', padding: '12px 16px',
            fontSize: '12px', color: colors.secondary, lineHeight: 1.6,
            textAlign: 'left', width: '100%',
          }}>
            <strong>Why?</strong> Live in-app scanning requires Chrome on Android.
            On iPhone, the built-in camera app scans QR codes natively — just hover it over the label.
          </div>
          <button
            onClick={() => router.push('/showroom/project-list')}
            style={{
              marginTop: '8px', width: '100%', padding: '12px',
              background: 'none', color: colors.secondary,
              border: `1.5px solid ${colors.border}`, borderRadius: '10px',
              fontSize: '13px', fontWeight: 600,
              cursor: 'pointer', fontFamily: font.body,
            }}
          >
            Back to Project List
          </button>
        </Centered>
      )}
    </Shell>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Shell({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div style={{
      minHeight: '100vh', background: colors.void,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 16px 48px',
    }}>
      <div style={{ width: '100%', maxWidth: '480px' }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px',
        }}>
          <button
            onClick={onBack}
            style={{
              background: 'none', border: 'none', padding: '4px',
              cursor: 'pointer', color: colors.tertiary, display: 'flex',
            }}
            aria-label="Back"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div style={{
            width: 26, height: 26, borderRadius: '6px', background: '#1A2035',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#DC1F2E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>
          <span style={{ fontSize: '12px', fontWeight: 700, color: colors.secondary, letterSpacing: '0.02em' }}>
            Scan Product QR
          </span>
        </div>

        {/* Card */}
        <div style={{
          width: '100%', background: colors.base,
          border: `1.5px solid ${colors.border}`, borderRadius: '16px',
          padding: '20px 18px 24px', boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '12px', padding: '24px 0', textAlign: 'center',
    }}>
      {children}
    </div>
  )
}

function IconBox({ emoji, color }: { emoji: string; color: string }) {
  return (
    <div style={{
      width: 48, height: 48, borderRadius: '12px', background: color,
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px',
    }}>
      {emoji}
    </div>
  )
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: font.display, fontSize: '18px', fontWeight: 700, color: colors.primary }}>
      {children}
    </div>
  )
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '13px', color: colors.tertiary, lineHeight: 1.6, maxWidth: '280px' }}>
      {children}
    </div>
  )
}

function PrimaryBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        marginTop: '4px', padding: '11px 24px',
        background: '#1A2035', color: '#fff',
        border: 'none', borderRadius: '9px',
        fontSize: '14px', fontWeight: 600,
        cursor: 'pointer', fontFamily: font.body,
      }}
    >
      {children}
    </button>
  )
}
