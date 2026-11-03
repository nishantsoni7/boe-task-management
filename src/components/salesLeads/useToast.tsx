'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import s from './salesLeads.module.css'

type ToastAction = { label: string; run: () => void }

/**
 * A short message at the bottom of the screen. `node` goes anywhere in the tree; `show` puts a message up. A refusal
 * (`error`) is announced as an alert and stays longer: it is the one the person needs to read. A message with an
 * `action` (Undo) stays long enough to be pressed.
 */
export function useToast() {
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [visible, setVisible] = useState(false)
  const [action, setAction] = useState<ToastAction | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const show = useCallback((text: string, isError = false, act: ToastAction | null = null) => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(text)
    setError(isError)
    setAction(act)
    setVisible(true)
    timer.current = setTimeout(() => setVisible(false), isError ? 9000 : act ? 8000 : 4000)
  }, [])

  const node = (
    <div className={`${s.toast}${visible ? ` ${s.toastOn}` : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>
      {message}
      {action && visible && (
        <button type="button" className={s.toastAction} onClick={() => { setVisible(false); action.run() }}>{action.label}</button>
      )}
    </div>
  )
  return { show, node }
}
