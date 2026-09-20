'use client'

// ── The microphone, in one place ─────────────────────────────────────────────
//
// Two surfaces listen now — the full expense form and Quick Capture — and they
// must behave identically: the same feature detection, the same language, the
// same refusal messages, and above all the same rule that RECOGNITION NEVER
// SAVES. Two copies of this would drift, and the copy that drifted would be the
// one that quietly gained an auto-submit.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
//
// NO AUDIO IS KEPT. The browser performs the recognition and hands back a
// string. Nothing here records, stores, uploads or transmits anything, there is
// no server involved, and the recogniser is aborted and discarded when the
// component unmounts.
//
// NOTHING IS SAVED. `onTranscript` receives a string and the caller puts it on
// screen. There is deliberately no path from this file to a write: the person
// reads what was heard and presses the button themselves, every time.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { VOICE_DENIED_MESSAGE, VOICE_UNSUPPORTED_MESSAGE } from '@/lib/finance/expenseVoice'

// ── Speech recognition, as a browser actually exposes it ─────────────────────
//
// FEATURE-DETECTED, NEVER ASSUMED. `SpeechRecognition` is unprefixed in a few
// browsers and `webkitSpeechRecognition` in Chrome and Edge; Firefox and most
// iOS browsers have neither. When it is absent the microphone is not drawn and
// the surface is untouched.
export type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
export type SpeechErrorEvent = { error: string }
export type Recognition = {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

export function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// ── "Does this browser have it?", answered without a cascading render ────────
//
// The answer differs between the server render (no) and the browser (maybe), so
// it cannot simply be read during render — that is a hydration mismatch — and
// setting it from an effect is a second render for a value that never changes.
// useSyncExternalStore is exactly this: a snapshot on the client, a separate one
// on the server, and a subscription that never fires because the capability of a
// loaded browser does not come and go.
const NEVER_CHANGES = () => () => {}
const supportedOnClient = () => recognitionCtor() !== null
const supportedOnServer = () => false

export function useVoiceSupported(): boolean {
  return useSyncExternalStore(NEVER_CHANGES, supportedOnClient, supportedOnServer)
}

export const VOICE_NOTHING_HEARD_MESSAGE =
  'Nothing was heard. Tap the microphone and try again.'

export type ExpenseSpeech = {
  supported: boolean
  listening: boolean
  /** One calm sentence when something went wrong, or null. */
  message: string | null
  clearMessage: () => void
  /** Starts listening, or stops if it already is. */
  toggle: () => void
}

/**
 * The microphone for one surface.
 *
 * @param onTranscript what was heard, verbatim. Called at most once per press,
 *                     never with an empty string, and never followed by a write.
 */
export function useExpenseSpeech(onTranscript: (heard: string) => void): ExpenseSpeech {
  const supported = useVoiceSupported()
  const [listening, setListening] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const recognitionRef = useRef<Recognition | null>(null)

  // The CURRENT callback, for a recogniser created when the button was pressed
  // and firing seconds later. A ref rather than a dependency, so the handler
  // that lands is the one the surface has now.
  const handlerRef = useRef(onTranscript)
  useEffect(() => { handlerRef.current = onTranscript }, [onTranscript])

  // Nothing survives the surface: the recogniser is aborted and dropped on
  // unmount, so no listener outlives the screen and no audio is retained.
  useEffect(() => () => { recognitionRef.current?.abort() }, [])

  const toggle = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) { setMessage(VOICE_UNSUPPORTED_MESSAGE); return }
    if (listening) { recognitionRef.current?.stop(); return }

    setMessage(null)

    let recognition: Recognition
    try {
      recognition = new Ctor()
    } catch {
      setMessage(VOICE_UNSUPPORTED_MESSAGE)
      return
    }
    // Indian English first: it is what these sentences are spoken in, and it
    // recognises Indian names and "rupees" far better than en-US.
    recognition.lang = 'en-IN'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.continuous = false
    recognition.onresult = (e: SpeechResultEvent) => {
      const heard = e.results?.[0]?.[0]?.transcript
      if (typeof heard === 'string' && heard.trim() !== '') handlerRef.current(heard)
      else setMessage(VOICE_NOTHING_HEARD_MESSAGE)
    }
    recognition.onerror = (e: SpeechErrorEvent) => {
      setListening(false)
      // A refused microphone is the one case worth naming precisely; everything
      // else gets one calm sentence and a surface that still works by typing.
      setMessage(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? VOICE_DENIED_MESSAGE
          : e.error === 'no-speech'
            ? VOICE_NOTHING_HEARD_MESSAGE
            : 'Voice entry could not run just now. Type it instead.')
    }
    recognition.onend = () => setListening(false)

    recognitionRef.current = recognition
    try {
      recognition.start()
      setListening(true)
    } catch {
      setListening(false)
      setMessage('Voice entry could not start. Type it instead.')
    }
  }, [listening])

  return {
    supported,
    listening,
    message,
    clearMessage: useCallback(() => setMessage(null), []),
    toggle,
  }
}
