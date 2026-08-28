'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { buildWaMeUrl, hasNeutralLanguage } from '@/lib/customerReviews/invitation'
import { waMePhone } from '@/lib/customerReviews/contact'

// The one control that reaches outside BOE — and it still does not send
// anything.
//
// WHAT THIS BUTTON DOES, IN ORDER
//   1. opens a blank tab SYNCHRONOUSLY, inside the click, so the browser treats
//      it as user-initiated and does not block it;
//   2. calls record_customer_review_whatsapp_opened(), which re-checks — in the
//      database, not here — that the caller owns the request, holds `use`, that
//      the request is Ready to Send, and that every sending prerequisite is
//      still met;
//   3. only then points that tab at wa.me with the invitation prefilled.
//
// If step 2 refuses, the tab is closed and the message never reaches WhatsApp.
// That ordering is the reason the RPC is not fired after the navigation: the
// database's answer has to arrive BEFORE the customer's chat opens, or the
// check is decoration.
//
// WHAT IT DOES NOT DO
// It does not send the message. WhatsApp opens with the text in the input box
// and a person still has to press send — which is why the RPC writes
// whatsapp_opened_at and NOT sent_at, and why confirming "I sent this" is a
// separate, deliberate action on the request screen.
//
// IT ALSO DOES NOT SEND THE PHOTOGRAPHS. A wa.me link carries a phone number
// and a text parameter and nothing else — there is no way to attach a file to
// one. The project photographs on a request are BOE's own private reference,
// and an employee who wants the customer to see them attaches them by hand in
// the chat. Nothing in this component, or anywhere in the module, may imply
// otherwise.
//
// REPEATED CLICKS are stopped twice over: a ref guard that rejects a second
// click while the first is still in flight (state is too slow — two clicks in
// the same tick would both see `busy === false`), and a cooldown afterwards, so
// a customer cannot be handed four identical chats because somebody
// double-tapped on a phone.

const COOLDOWN_MS = 5000

export function WhatsAppLaunchButton({
  supabase,
  requestId,
  whatsappNumber,
  message,
  /** False when the caller is not the owner, or the request is not Ready to Send. */
  enabled,
  onOpened,
  onError,
}: {
  supabase: SupabaseClient
  requestId: string
  whatsappNumber: string | null
  message: string
  enabled: boolean
  onOpened?: () => void
  onError?: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)
  const inFlight = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current)
  }, [])

  const phone = waMePhone(whatsappNumber)

  // The last line of defence for the promise this module makes. If a future
  // refactor produced a message that had lost the neutral-feedback or
  // customer-choice sentences, the button goes dead rather than quietly sending
  // a one-sided ask.
  const neutral = hasNeutralLanguage(message)

  const ready = enabled && !!phone && neutral && !busy && !cooling

  const launch = useCallback(async () => {
    if (inFlight.current || !ready || !phone) return
    inFlight.current = true
    setBusy(true)

    // Opened inside the click so the popup blocker permits it. Everything after
    // this point either points the tab somewhere or closes it.
    const tab = window.open('', '_blank', 'noopener,noreferrer')

    try {
      const { error } = await supabase.rpc('record_customer_review_whatsapp_opened', {
        p_request_id: requestId,
      })
      if (error) {
        tab?.close()
        // The message is the database's own sentence, which never contains the
        // customer's number or the invitation body — see the RAISE statements
        // in 20261017000000.
        onError?.(error.message.replace(/^[A-Z_]+:\s*/, '') || 'Could not open WhatsApp for this request.')
        return
      }

      const url = buildWaMeUrl(phone, message)
      if (tab) tab.location.href = url
      // A blocked popup is not a failure of the record: the invitation was
      // prepared, so the fallback opens in this tab rather than silently doing
      // nothing.
      else window.location.href = url

      onOpened?.()
      setCooling(true)
      cooldownTimer.current = setTimeout(() => setCooling(false), COOLDOWN_MS)
    } catch {
      tab?.close()
      onError?.('Could not open WhatsApp for this request.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [ready, phone, supabase, requestId, message, onOpened, onError])

  return (
    <div>
      <button
        type="button"
        onClick={launch}
        disabled={!ready}
        className="boe-btn boe-btn-primary"
        style={{
          display: 'flex', alignItems: 'center', gap: '7px',
          padding: '9px 18px', fontSize: '13px',
          opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed',
        }}
      >
        <Send size={14} strokeWidth={2.2} />
        {busy ? 'Opening…' : cooling ? 'Opened — wait a moment' : 'Open WhatsApp'}
      </button>
      <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px', lineHeight: 1.5 }}>
        WhatsApp opens with this text ready, and nothing else — no photographs are attached. You
        still have to press send there; BOE never sends it for you.
      </p>
      {!neutral && (
        <p role="alert" style={{ fontSize: '11px', color: colors.red, marginTop: '4px' }}>
          This invitation is missing its neutral-feedback wording and cannot be sent.
        </p>
      )}
    </div>
  )
}
