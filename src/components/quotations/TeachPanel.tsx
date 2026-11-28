'use client'

// "Teach my price" (28 Nov 2026; the owner approved the mockup): the Training case form as a panel over the quotation, started from the
// line (its photo, name, size, material, quantity, price, and whatever was typed in the note box), instead of a new browser tab. Saving
// teaches the case (saved and submitted in one go) and the builder puts it on the line. Escape or Cancel closes it; a click outside does
// not, because a case being typed is not something to lose by a stray click.

import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialogFocus } from '@/components/salesLeads/useDialogFocus'
import { TrainingCase, type EmbeddedCase } from '@/components/pricing/training/TrainingCase'
import type { Prefill } from '@/lib/pricing/training/prefill'
import w from './teachPanel.module.css'

export function TeachPanel({ prefill, onTaught, onClose, lineName }: { prefill: Prefill; onTaught: EmbeddedCase['onTaught']; onClose: () => void; lineName: string }) {
  const sheet = useDialogFocus<HTMLDivElement>(onClose)
  return createPortal(
    <div className={w.scrim}>
      <div className={w.drawer} role="dialog" aria-modal="true" aria-labelledby="teach-title" ref={sheet} tabIndex={-1}>
        <div className={w.head}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="teach-title">Teach this price</h2>
            <p>{lineName}. Your quotation stays open behind this panel and is not changed until you save.</p>
          </div>
          <button type="button" className="boe-btn boe-btn-secondary" onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
        </div>
        <div className={w.scroll}><TrainingCase embedded={{ prefill, onTaught, onCancel: onClose }} /></div>
      </div>
    </div>,
    document.body,
  )
}
