'use client'

import { useState, useCallback, useRef } from 'react'

export type ToastVariant = 'success' | 'error' | 'info'

type ToastState = { id: number; message: string; variant: ToastVariant } | null

export function useToast() {
  const [toast, setToast] = useState<ToastState>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((message: string, variant: ToastVariant = 'success') => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ id: Date.now(), message, variant })
    timer.current = setTimeout(() => setToast(null), 2500)
  }, [])

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setToast(null)
  }, [])

  return { toast, show, dismiss }
}

const VARIANT_BG: Record<ToastVariant, string> = {
  success: '#276247',
  error:   '#B42332',
  info:    '#335A86',
}

export function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  if (!toast) return null
  return (
    <div
      key={toast.id}
      onClick={onDismiss}
      style={{
        position: 'fixed',
        bottom: '28px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: VARIANT_BG[toast.variant],
        color: '#fff',
        padding: '10px 22px',
        borderRadius: '12px',
        fontSize: '14px',
        fontWeight: 600,
        boxShadow: '0 8px 24px rgba(48,53,54,0.18)',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        animation: 'boe-toast-in 0.15s ease',
      }}
    >
      {toast.message}
    </div>
  )
}
