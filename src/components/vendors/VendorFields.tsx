'use client'

import { CAPABILITIES, CATEGORIES } from '@/lib/vendors/constants'
import type { VendorInput } from '@/lib/vendors/api'
import type { FieldErrors, VendorField } from '@/lib/vendors/validation'
import { Chips, Field } from './VendorBits'
import s from './vendors.module.css'

// The vendor profile, kept to what the owner actually asked for: who and where, what they can do, how big, and
// who recommended them. Anything else goes in Notes.
//   Registered vendor (a site visit): company, contact, mobile, city, address and what they can do are required.
//   Potential / contacted vendor (`relaxed`): only the company name is, and the rest waits under "More details".

type Props = {
  value: VendorInput
  errors: FieldErrors<VendorField>
  onChange: (patch: Partial<VendorInput>) => void
  relaxed?: boolean
}

export default function VendorFields({ value, errors, onChange, relaxed = false }: Props) {
  const need = !relaxed
  const cls = (k: VendorField) => `${s.input}${errors[k] ? ` ${s.invalid}` : ''}`

  const capabilities = (
    <Field label="What they do" required={need} error={errors.capabilities}>
      <Chips multiple label="What they do" options={CAPABILITIES} value={value.capabilities}
             onChange={v => onChange({ capabilities: v as string[] })} />
    </Field>
  )
  const address = (
    <Field label="Address" required={need} error={errors.address} htmlFor="v-address" hint="Exact location of the factory">
      <textarea id="v-address" rows={2} className={`${s.textarea}${errors.address ? ` ${s.invalid}` : ''}`} value={value.address}
                maxLength={500} onChange={e => onChange({ address: e.target.value })} />
    </Field>
  )

  const referredBy = (
    <Field label="Recommended by" htmlFor="v-ref" hint="Who gave us this reference">
      <input id="v-ref" className={s.input} value={value.referred_by} maxLength={200}
             onChange={e => onChange({ referred_by: e.target.value })} />
    </Field>
  )

  return (
    <div className={s.formStack}>
      <Field label="Company" required error={errors.company_name} htmlFor="v-company">
        <input id="v-company" className={cls('company_name')} value={value.company_name} maxLength={160}
               autoComplete="off" onChange={e => onChange({ company_name: e.target.value })} />
      </Field>
      {relaxed && referredBy}
      <Field label="Contact person" required={need} error={errors.contact_name} htmlFor="v-contact">
        <input id="v-contact" className={cls('contact_name')} value={value.contact_name} maxLength={120}
               autoComplete="off" onChange={e => onChange({ contact_name: e.target.value })} />
      </Field>
      <Field label="Mobile" required={need} error={errors.phone} htmlFor="v-phone">
        <input id="v-phone" className={cls('phone')} value={value.phone} inputMode="tel" autoComplete="off"
               placeholder="98765 43210" onChange={e => onChange({ phone: e.target.value })} />
      </Field>
      <Field label="City" required={need} error={errors.city} htmlFor="v-city">
        <input id="v-city" className={cls('city')} value={value.city} maxLength={80}
               onChange={e => onChange({ city: e.target.value })} />
      </Field>
      {!relaxed && address}
      {!relaxed && capabilities}

      <details className={s.more}>
        <summary>More details</summary>
        <div className={s.moreBody}>
          {!relaxed && referredBy}
          {relaxed && address}
          {relaxed && capabilities}
          <Field label="Products">
            <Chips multiple label="Products" options={CATEGORIES} value={value.categories}
                   onChange={v => onChange({ categories: v as string[] })} />
          </Field>
          <Field label="People" error={errors.headcount} htmlFor="v-head" hint="How many work at the unit">
            <input id="v-head" className={cls('headcount')} value={value.headcount} inputMode="numeric" maxLength={4}
                   style={{ maxWidth: 120 }} onChange={e => onChange({ headcount: e.target.value })} />
          </Field>
          <Field label="Notes" htmlFor="v-notes">
            <textarea id="v-notes" rows={3} className={s.textarea} value={value.notes} maxLength={2000}
                      onChange={e => onChange({ notes: e.target.value })} />
          </Field>
        </div>
      </details>
    </div>
  )
}
