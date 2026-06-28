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
  success: '#16A34A',
  error:   '#DC2626',
  info:    '#2563EB',
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
        borderRadius: '8px',
        fontSize: '13px',
        fontWeight: 600,
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
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
