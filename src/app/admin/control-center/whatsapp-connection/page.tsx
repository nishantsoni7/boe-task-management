'use client'

// Admin Control Center → WhatsApp Connection.
//
// Connects the company's WhatsApp number to BOE One WITHOUT taking it off the phone that
// chats on it: Meta's Embedded Signup pop-up with WhatsApp Business app onboarding
// ("coexistence"). From then on customer chats reach /api/sales/capture/whatsapp exactly
// like the test number's do (dossier 28).
//
// This page only opens Meta's pop-up and shows what Meta reports back. It sends no
// message, keeps no token and calls no Meta address itself: we connect our OWN business,
// so the code Meta hands back is left to expire, and the one-time "subscribe BOE One to
// the new account" step is done by hand (dossier 28). Admin-only through
// control-center/layout.tsx; nothing on it is secret (app ID and config ID are public).

import Script from 'next/script'
import { useEffect, useState } from 'react'
import { CcSection, cc } from '@/components/controlCenter/CcPrimitives'
import { META_GRAPH_VERSION } from '@/lib/meta/graph'
import { readSignupEvent, type SignupEvent } from '@/lib/salesLeads/connectSignup'

const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID ?? ''
const CONFIG_ID = process.env.NEXT_PUBLIC_WA_SIGNUP_CONFIG_ID ?? ''

type FbSdk = {
  init: (o: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void
  login: (callback: () => void, options: Record<string, unknown>) => void
}
const sdk = () => (window as Window & { FB?: FbSdk }).FB

const STEPS = [
  'Before you start: Meta has approved the app\'s two WhatsApp permissions, the Claude balance is topped up, and the phone with the company number is in your hand with WhatsApp Business updated.',
  'Press Connect WhatsApp, log in to Facebook, choose the business "Best of Exports New", then choose to connect your EXISTING WhatsApp Business app and enter the company number.',
  'On the phone: open WhatsApp Business and tap Connect on Meta\'s message (or Settings > Account > Business Platform). When asked, do NOT share chat history.',
  'Give Claude the account ID shown below for the one-time subscribe step. Chats reach the Lead Master after that.',
]

export default function WhatsAppConnectionPage() {
  const configured = APP_ID !== '' && CONFIG_ID !== ''
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SignupEvent | null>(null)

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const event = readSignupEvent(e.origin, e.data)
      if (event) { setResult(event); setBusy(false) }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const connect = () => {
    const fb = sdk()
    if (!fb) return
    setResult(null)
    setBusy(true)
    // The callback only carries a short-lived code we do not need; the result arrives as a message.
    fb.login(() => setBusy(false), {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    })
  }

  return (
    <div style={{ maxWidth: 760 }}>
      {configured && (
        <Script
          src="https://connect.facebook.net/en_US/sdk.js"
          strategy="afterInteractive"
          crossOrigin="anonymous"
          onReady={() => {
            sdk()?.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: META_GRAPH_VERSION })
            setReady(true)
          }}
        />
      )}

      <div className={`${cc.note} ${cc.noteAmber}`} style={{ marginBottom: 16 }}>
        <span className={cc.noteTitle}>Connect the number only from this page.</span>
        Never add the company number with &quot;Add phone number&quot; in Meta&apos;s dashboard: that moves it off the
        WhatsApp Business app on the phone. Here it stays on the phone, and customer chats also reach the Lead Master.
      </div>

      {!configured && (
        <div className={`${cc.note} ${cc.noteRed}`} style={{ marginBottom: 16 }} role="alert">
          <span className={cc.noteTitle}>Setup missing</span>
          NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_WA_SIGNUP_CONFIG_ID must both be set in Vercel, then redeploy.
        </div>
      )}

      <CcSection
        title="Connect the company WhatsApp number"
        description="It stays on the phone. BOE One only receives customer chats; it never sends anything."
      >
        {STEPS.map((step, i) => (
          <div key={i} className={cc.step} style={{ alignItems: 'flex-start' }}>
            <span className={cc.stepNum}>{i + 1}</span>
            <span style={{ fontSize: 13 }}>{step}</span>
          </div>
        ))}
        <button
          className="boe-btn boe-btn-primary"
          style={{ marginTop: 8 }}
          disabled={!configured || !ready || busy}
          onClick={connect}
        >
          {busy ? 'Waiting for Meta…' : 'Connect WhatsApp'}
        </button>
      </CcSection>

      {result?.kind === 'finished' && (
        <div className={`${cc.note} ${cc.noteGreen}`} style={{ marginTop: 16 }} role="status">
          <span className={cc.noteTitle}>Meta connected the WhatsApp Business app number.</span>
          Next: give Claude these IDs to subscribe BOE One to the account. Chats start arriving after that.
          <div className={cc.mono} style={{ marginTop: 6 }}>
            WhatsApp account ID {result.wabaId}
            {result.phoneNumberId && ` · Phone number ID ${result.phoneNumberId}`}
          </div>
        </div>
      )}
      {result?.kind === 'wrong-flow' && (
        <div className={`${cc.note} ${cc.noteRed}`} style={{ marginTop: 16 }} role="alert">
          <span className={cc.noteTitle}>Meta finished a different kind of connection ({result.event}).</span>
          The number may have been moved off the WhatsApp Business app. Check the phone now and tell Claude before
          doing anything else.
        </div>
      )}
      {result?.kind === 'cancelled' && (
        <div className={`${cc.note} ${cc.noteAmber}`} style={{ marginTop: 16 }} role="status">
          <span className={cc.noteTitle}>Stopped at {result.step}.</span>
          Nothing was connected. You can press Connect WhatsApp again.
        </div>
      )}
      {result?.kind === 'error' && (
        <div className={`${cc.note} ${cc.noteRed}`} style={{ marginTop: 16 }} role="alert">
          <span className={cc.noteTitle}>Meta reported a problem.</span>
          {result.message}
        </div>
      )}
    </div>
  )
}
