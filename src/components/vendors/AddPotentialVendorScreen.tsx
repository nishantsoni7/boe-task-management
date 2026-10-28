'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { newSubmissionId } from '@/lib/exhibitionLeads/draft'
import { VENDORS_KEY, saveVendor } from '@/lib/vendors/api'
import { CATEGORIES } from '@/lib/vendors/constants'
import { EMPTY_VENDOR, validateVendor, vendorPayload } from '@/lib/vendors/validation'
import { Chips, Field } from './VendorBits'
import s from './vendors.module.css'

// A vendor we have heard about but not visited. Twenty seconds on a phone: the name and who recommended them
// are what matter; everything else can be filled in later, when someone meets or visits them. A visit to
// their factory later registers them properly.

type Stage = 'potential' | 'contacted'

export default function AddPotentialVendorScreen() {
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const router = useRouter()
  const qc = useQueryClient()
  const [form, setForm] = useState(EMPTY_VENDOR)
  const [stage, setStage] = useState<Stage>('potential')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [errors, setErrors] = useState<ReturnType<typeof validateVendor>>({})
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null)
  const key = useRef(newSubmissionId())

  if (loading || !profile) return <LoadingScreen />

  async function save() {
    if (busy) return
    const e = validateVendor(form, true)
    setErrors(e)
    setDuplicate(null)
    if (Object.keys(e).length > 0) { setProblem('Some details need attention — they are marked in red.'); return }
    setBusy(true)
    setProblem(null)
    try {
      const res = await saveVendor(supabase, key.current, null, { ...vendorPayload(form), status: stage })
      if (res.status === 'duplicate') {
        setDuplicate({ id: res.id, name: res.company_name })
        setBusy(false)
        return
      }
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
      router.push(`/vendors/${res.id}`)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not save. Nothing was confirmed saved — try again.')
      setBusy(false)
    }
  }

  const cls = (k: keyof typeof errors) => `${s.input}${errors[k] ? ` ${s.invalid}` : ''}`

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Add a Potential Vendor"
                   subtitle="Someone we have heard about, not visited yet">
      <div className={s.wrap}>
        <div className={s.card}>
          <Field label="Company / workshop name" required error={errors.company_name} htmlFor="p-name">
            <input id="p-name" className={cls('company_name')} value={form.company_name} maxLength={160} autoComplete="off"
                   onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))} />
          </Field>
          <Field label="Who recommended them?" htmlFor="p-ref"
                 hint="The person or company that gave us this reference — so it can be followed up">
            <input id="p-ref" className={s.input} value={form.referred_by} maxLength={200} autoComplete="off"
                   onChange={e => setForm(f => ({ ...f, referred_by: e.target.value }))} />
          </Field>
          <div className={s.grid2}>
            <Field label="Contact person" htmlFor="p-contact">
              <input id="p-contact" className={s.input} value={form.contact_name} maxLength={120} autoComplete="off"
                     onChange={e => setForm(f => ({ ...f, contact_name: e.target.value }))} />
            </Field>
            <Field label="Mobile number" error={errors.phone} htmlFor="p-phone" hint="If you have it">
              <input id="p-phone" className={cls('phone')} value={form.phone} inputMode="tel" autoComplete="off"
                     onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </Field>
            <Field label="City" htmlFor="p-city">
              <input id="p-city" className={s.input} value={form.city} maxLength={80}
                     onChange={e => setForm(f => ({ ...f, city: e.target.value }))} />
            </Field>
          </div>
          <Field label="What do they make?">
            <Chips multiple label="What they make" options={CATEGORIES} value={form.categories}
                   onChange={v => setForm(f => ({ ...f, categories: v as string[] }))} />
          </Field>
          <Field label="Where are we with them?">
            <Chips label="Stage" value={stage} onChange={v => setStage(v as Stage)} options={[
              { value: 'potential', label: 'Not contacted yet' },
              { value: 'contacted', label: 'Already spoken to' },
            ]} />
          </Field>
          <Field label="Notes" htmlFor="p-notes">
            <textarea id="p-notes" className={s.textarea} value={form.notes} maxLength={2000}
                      onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </Field>

          {duplicate && (
            <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
              We already have <strong>{duplicate.name}</strong> in the list.{' '}
              <Link className={s.linkBtn} href={`/vendors/${duplicate.id}`}>Open it</Link>
            </div>
          )}
          {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Add vendor'}</button>
            <Link className={s.secondary} href="/vendors">Cancel</Link>
          </div>
        </div>
      </div>
    </VendorsLayout>
  )
}
