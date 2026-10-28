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
import { EMPTY_VENDOR, validateVendor, vendorPayload } from '@/lib/vendors/validation'
import VendorFields from './VendorFields'
import s from './vendors.module.css'

// A vendor we have heard about but not visited. A name and who recommended them are enough; the rest can wait
// until someone meets or visits them. A visit to their factory later registers them properly.

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
    if (Object.keys(e).length > 0) { setProblem('Some details need attention.'); return }
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

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Add Vendor">
      <div className={s.wrap}>
        <section className={s.section}>
          <div className={s.segmented} role="radiogroup" aria-label="Where are we with them">
            {([['potential', 'Not contacted yet'], ['contacted', 'Already spoken to']] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={stage === v}
                      className={`${s.segment}${stage === v ? ` ${s.segmentOn}` : ''}`} onClick={() => setStage(v)}>{label}</button>
            ))}
          </div>
          <div className={s.hint}>A vendor we have heard about. A name is enough for now.</div>
        </section>

        <section className={s.section}>
          <VendorFields relaxed value={form} errors={errors} onChange={patch => setForm(f => ({ ...f, ...patch }))} />
        </section>

        {duplicate && (
          <div className={`${s.banner} ${s.bannerWarn}`} role="alert">
            <strong>{duplicate.name}</strong> is already in the list. <Link className={s.linkBtn} href={`/vendors/${duplicate.id}`}>Open it</Link>
          </div>
        )}
        {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
        <div className={`${s.submitBar} ${s.submitBarEnd}`}>
          <Link className={s.secondary} href="/vendors">Cancel</Link>
          <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Add vendor'}</button>
        </div>
      </div>
    </VendorsLayout>
  )
}
