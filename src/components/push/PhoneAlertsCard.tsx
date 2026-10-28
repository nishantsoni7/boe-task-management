'use client'

import { useCallback, useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { PUSH_CATEGORIES, PUSH_CATEGORY_LABELS } from '@/lib/push/pushPolicy'
import {
  detectPushSupport, registerPushWorker, urlBase64ToUint8Array, type PushSupport,
} from '@/lib/push/client'

const card: React.CSSProperties = {
  background: '#fff',
  border: `1px solid ${colors.border}`,
  borderRadius: 12,
  padding: '20px 22px',
}

const button: React.CSSProperties = {
  padding: '9px 20px', fontSize: 13.5, fontWeight: 600,
  background: colors.brand, color: '#fff',
  border: 'none', borderRadius: 8, cursor: 'pointer',
}

const quietButton: React.CSSProperties = {
  ...button, background: '#fff', color: colors.primary, border: `1px solid ${colors.border}`,
}

const note: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, lineHeight: 1.5, color: colors.secondary }

type Phase = 'loading' | 'off' | 'on' | 'denied'

// Account Settings -> "Phone alerts". Turns lock-screen alerts on or off for THIS
// device and lets the person mute categories. The banner text is generic by
// design (the lock screen is public); the details are in the inbox.
export function PhoneAlertsCard() {
  const [support, setSupport] = useState<PushSupport>('supported')
  const [phase, setPhase] = useState<Phase>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState<string[]>([])

  const refresh = useCallback(async () => {
    const found = detectPushSupport()
    setSupport(found)
    if (found !== 'supported') { setPhase('off'); return }
    if (Notification.permission === 'denied') { setPhase('denied'); return }
    try {
      const registration = await registerPushWorker()
      const existing = await registration.pushManager.getSubscription()
      setPhase(existing && Notification.permission === 'granted' ? 'on' : 'off')
    } catch {
      setPhase('off')
    }
  }, [])

  useEffect(() => {
    // The lookup is async, so state is set after the first render, not inside the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    void fetch('/api/push/preferences')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { muted?: string[] } | null) => { if (j?.muted) setMuted(j.muted) })
      .catch(() => undefined)
  }, [refresh])

  async function turnOn() {
    setBusy(true)
    setError(null)
    try {
      const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!publicKey) throw new Error('Phone alerts are not switched on for this app yet.')
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') { setPhase(permission === 'denied' ? 'denied' : 'off'); return }
      const registration = await registerPushWorker()
      await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      const res = await fetch('/api/push/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
      if (!res.ok) {
        await subscription.unsubscribe().catch(() => undefined)
        throw new Error('Could not turn on phone alerts. Please try again.')
      }
      setPhase('on')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn on phone alerts.')
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setBusy(true)
    setError(null)
    try {
      const registration = await registerPushWorker()
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await fetch('/api/push/subscription', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        })
        await subscription.unsubscribe()
      }
      setPhase('off')
    } catch {
      setError('Could not turn off phone alerts. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleCategory(category: string) {
    const next = muted.includes(category) ? muted.filter((c) => c !== category) : [...muted, category]
    const before = muted
    setMuted(next)
    const res = await fetch('/api/push/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: next }),
    }).catch(() => null)
    if (!res?.ok) { setMuted(before); setError('Could not save that change.') }
  }

  return (
    <section style={card}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: colors.primary, display: 'flex', alignItems: 'center', gap: 8 }}>
        <BellRing size={16} aria-hidden /> Phone alerts
      </h2>
      <p style={note}>
        Get a notification on this device when something needs you, even when BOE One is closed.
        The banner is kept general (for example &ldquo;Finance update&rdquo;); open the app for the details.
      </p>

      {support === 'needs_home_screen' && (
        <p style={note}>
          On iPhone, add BOE One to your Home Screen first: tap Share, then &ldquo;Add to Home Screen&rdquo;,
          open BOE One from that icon, and come back here.
        </p>
      )}
      {support === 'unsupported' && (
        <p style={note}>This browser cannot receive phone alerts. Try Chrome, Edge or Safari (installed to the Home Screen).</p>
      )}
      {support === 'supported' && phase === 'denied' && (
        <p style={note}>Notifications are blocked for BOE One. Allow them in your browser or phone settings, then return here.</p>
      )}

      {support === 'supported' && phase === 'off' && (
        <div style={{ marginTop: 14 }}>
          <button type="button" style={button} disabled={busy} onClick={turnOn}>
            {busy ? 'Turning on…' : 'Turn on phone alerts'}
          </button>
        </div>
      )}

      {support === 'supported' && phase === 'on' && (
        <div style={{ marginTop: 14 }}>
          <p style={{ ...note, marginTop: 0, color: colors.primary }}>Alerts are on for this device.</p>
          <fieldset style={{ border: 'none', padding: 0, margin: '12px 0 0' }}>
            <legend style={{ fontSize: 13, fontWeight: 600, color: colors.primary, padding: 0 }}>Alert me about</legend>
            {PUSH_CATEGORIES.map((category) => (
              <label key={category} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={!muted.includes(category)}
                  onChange={() => void toggleCategory(category)}
                />
                {PUSH_CATEGORY_LABELS[category]}
              </label>
            ))}
          </fieldset>
          <div style={{ marginTop: 12 }}>
            <button type="button" style={quietButton} disabled={busy} onClick={turnOff}>
              {busy ? 'Turning off…' : 'Turn off on this device'}
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" style={{ ...note, color: colors.brandInk }}>{error}</p>}
    </section>
  )
}
