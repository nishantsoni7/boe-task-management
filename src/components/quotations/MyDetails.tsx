'use client'

// The salesperson's details on their quotations (owner, 18 Nov 2026: "Do not keep anything as demo in this. Ask Sales person
// to fill in the data once (and keep it editable for future usage) and then have that information displayed in the Quotation.")
// Filled in once, printed on every quotation they own (page 2 and the signing page), changeable here at any time. Until they
// save, the builder and the print page ask for them; the form starts from what their profile already has.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorText, fetchMyCard, quotationKeys, saveMyCard, type MyCard } from '@/lib/quotations/api'
import type { createClient } from '@/lib/supabase/client'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>
type Fields = Pick<MyCard, 'name' | 'title' | 'phone' | 'email'>

function Form({ supabase, start, onDone }: { supabase: Supabase; start: Fields; onDone: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState<Fields>(start)
  const save = useMutation({
    mutationFn: () => saveMyCard(supabase, f),
    onSuccess: card => {
      qc.setQueryData(quotationKeys.myCard, card)
      // every quotation of theirs prints the new details
      void qc.invalidateQueries({ queryKey: ['quotations', 'one'] })
      onDone()
    },
  })
  const field = (k: keyof Fields, label: string, hint: string, type = 'text') => (
    <label className={s.field}><span>{label}</span>
      <input className={s.input} type={type} value={f[k]} onChange={e => setF(p => ({ ...p, [k]: e.target.value }))} placeholder={hint} disabled={save.isPending} /></label>
  )
  return (
    <form style={{ display: 'grid', gap: 10 }} onSubmit={e => { e.preventDefault(); save.mutate() }}>
      {field('name', 'Your name, as it prints', 'e.g. Mohit Sharma')}
      {field('title', 'Your role', 'e.g. Sales Manager')}
      {field('phone', 'Mobile (WhatsApp)', 'e.g. +91 98290 12345', 'tel')}
      {field('email', 'E-mail', 'e.g. mohit@bestofexports.com', 'email')}
      {save.isError && <div className={`${s.notice} ${s.noticeBad}`} role="alert">{errorText(save.error)}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className={s.btn} onClick={onDone} disabled={save.isPending}>Cancel</button>
        <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={save.isPending || f.name.trim().length < 2}>{save.isPending ? 'Saving…' : 'Save my details'}</button>
      </div>
    </form>
  )
}

/** The form in a dialog, opened from the reminder or from "My details". */
export function MyDetailsDialog({ supabase, onClose }: { supabase: Supabase; onClose: () => void }) {
  const q = useQuery({ queryKey: quotationKeys.myCard, queryFn: () => fetchMyCard(supabase), staleTime: 5 * 60_000 })
  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.modal} style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="my-details-title">
        <div className={s.cardHead}><h2 id="my-details-title">Your details on quotations</h2><span className={s.spacer} /><button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12 }}>
          <div className={`${s.small} ${s.muted}`}>They print on every quotation you own: on page 2 and beside the signature. A blank mobile or e-mail prints nothing.</div>
          {q.isError ? <div className={`${s.notice} ${s.noticeBad}`} role="alert">{errorText(q.error)}</div>
            : !q.data ? <div className={`${s.small} ${s.muted}`}>Loading…</div>
            : <Form supabase={supabase} start={{ name: q.data.name, title: q.data.title, phone: q.data.phone, email: q.data.email }} onDone={onClose} />}
        </div>
      </div>
    </div>
  )
}

/** Shown until the salesperson has saved their details once; nothing after that. */
export function MyDetailsReminder({ supabase }: { supabase: Supabase }) {
  const q = useQuery({ queryKey: quotationKeys.myCard, queryFn: () => fetchMyCard(supabase), staleTime: 5 * 60_000 })
  const [open, setOpen] = useState(false)
  if (!q.data || q.data.saved) return open ? <MyDetailsDialog supabase={supabase} onClose={() => setOpen(false)} /> : null
  return (
    <>
      <div className={`${s.notice} ${s.noticeWarn}`} role="status">
        <div className={s.row}>
          <span>Your name, role, mobile and e-mail print on your quotations. Fill them in once; you can change them later.</span>
          <span className={s.spacer} />
          <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setOpen(true)}>Fill in my details</button>
        </div>
      </div>
      {open && <MyDetailsDialog supabase={supabase} onClose={() => setOpen(false)} />}
    </>
  )
}
