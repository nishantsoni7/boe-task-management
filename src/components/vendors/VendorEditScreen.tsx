'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { VendorsLayout } from '@/components/layout/VendorsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useVendors } from '@/hooks/useVendors'
import { VENDORS_KEY, fetchVendor, saveVendor, type VendorInput } from '@/lib/vendors/api'
import { newSubmissionId } from '@/lib/exhibitionLeads/draft'
import { PRE_VISIT_STATUSES } from '@/lib/vendors/constants'
import { EMPTY_VENDOR, validateVendor, vendorPayload, type FieldErrors, type VendorField } from '@/lib/vendors/validation'
import VendorFields from './VendorFields'
import s from './vendors.module.css'

// Edit a vendor's profile. The visits are a record and are never edited.

export default function VendorEditScreen() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const { supabase, profile, isAdmin, loading, signOut } = useVendors()
  const [value, setValue] = useState<VendorInput>(EMPTY_VENDOR)
  const [loaded, setLoaded] = useState(false)
  const [errors, setErrors] = useState<FieldErrors<VendorField>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: [VENDORS_KEY, 'detail', id],
    queryFn: () => fetchVendor(supabase, id),
    enabled: !!profile,
  })

  // Filled once, while rendering, when the vendor arrives (so the form never shows empty then jumps).
  const v = detail.data?.vendor
  if (v && !loaded) {
    setLoaded(true)
    setValue({
      company_name: v.company_name, contact_name: v.contact_name ?? '', phone: v.phone ?? '', address: v.address ?? '',
      city: v.city ?? '', capabilities: v.capabilities, categories: v.categories,
      headcount: v.headcount === null ? '' : String(v.headcount), referred_by: v.referred_by ?? '', notes: v.notes ?? '',
    })
  }

  if (loading || !profile || detail.isLoading) return <LoadingScreen />

  async function save() {
    const e = validateVendor(value, relaxed)
    setErrors(e)
    if (Object.keys(e).length > 0) { setProblem('Some details need attention — they are marked in red.'); return }
    setBusy(true)
    setProblem(null)
    try {
      await saveVendor(supabase, newSubmissionId(), id, vendorPayload(value))
      await qc.invalidateQueries({ queryKey: [VENDORS_KEY] })
      router.push(`/vendors/${id}`)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not save. Try again.')
      setBusy(false)
    }
  }

  // A vendor nobody has visited yet may stay a name and a few notes; a registered one needs the whole profile.
  const relaxed = !!detail.data && PRE_VISIT_STATUSES.some(st => st === detail.data.vendor.status)

  return (
    <VendorsLayout profile={profile} isAdmin={isAdmin} onSignOut={signOut} title="Edit Vendor" subtitle={detail.data?.vendor.company_name}>
      <div className={s.wrap}>
        {detail.error && <div className={`${s.banner} ${s.bannerErr}`} role="alert">This vendor is not available.</div>}
        {detail.data && (
          <>
            <section className={s.section}>
              <VendorFields relaxed={relaxed} value={value} errors={errors} onChange={patch => setValue(v => ({ ...v, ...patch }))} />
            </section>
            {problem && <div className={`${s.banner} ${s.bannerErr}`} role="alert">{problem}</div>}
            <div className={s.submitBar}>
              <Link className={s.secondary} href={`/vendors/${id}`}>Cancel</Link>
              <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
            </div>
          </>
        )}
      </div>
    </VendorsLayout>
  )
}
