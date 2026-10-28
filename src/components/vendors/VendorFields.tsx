'use client'

import { CAPABILITIES, CATEGORIES } from '@/lib/vendors/constants'
import type { VendorInput } from '@/lib/vendors/api'
import type { FieldErrors, VendorField } from '@/lib/vendors/validation'
import { Chips, Field } from './VendorBits'
import s from './vendors.module.css'

// The vendor profile fields — used when a visit introduces a new vendor and on the Edit page.

type Props = {
  value: VendorInput
  errors: FieldErrors<VendorField>
  onChange: (patch: Partial<VendorInput>) => void
  /** A potential / contacted vendor: only the name is required, so the other fields lose their red stars. */
  relaxed?: boolean
}

export default function VendorFields({ value, errors, onChange, relaxed = false }: Props) {
  const need = !relaxed
  const cls = (k: VendorField) => `${s.input}${errors[k] ? ` ${s.invalid}` : ''}`
  return (
    <>
      <div className={s.grid2}>
        <Field label="Company name" required error={errors.company_name} htmlFor="v-company">
          <input id="v-company" className={cls('company_name')} value={value.company_name} maxLength={160}
                 autoComplete="off" onChange={e => onChange({ company_name: e.target.value })} />
        </Field>
        <Field label="Contact person" required={need} error={errors.contact_name} htmlFor="v-contact">
          <input id="v-contact" className={cls('contact_name')} value={value.contact_name} maxLength={120}
                 autoComplete="off" onChange={e => onChange({ contact_name: e.target.value })} />
        </Field>
        <Field label="Designation" htmlFor="v-desig" hint="Owner, partner, manager…">
          <input id="v-desig" className={s.input} value={value.contact_designation} maxLength={80}
                 onChange={e => onChange({ contact_designation: e.target.value })} />
        </Field>
        <Field label="Mobile number" required={need} error={errors.phone} htmlFor="v-phone" hint="+91 is added for a 10-digit number">
          <input id="v-phone" className={cls('phone')} value={value.phone} inputMode="tel" autoComplete="off"
                 onChange={e => onChange({ phone: e.target.value })} />
        </Field>
        <Field label="Second number" error={errors.alt_phone} htmlFor="v-alt">
          <input id="v-alt" className={cls('alt_phone')} value={value.alt_phone} inputMode="tel" autoComplete="off"
                 onChange={e => onChange({ alt_phone: e.target.value })} />
        </Field>
        <Field label="Email" error={errors.email} htmlFor="v-email">
          <input id="v-email" className={cls('email')} value={value.email} inputMode="email" autoComplete="off" maxLength={120}
                 onChange={e => onChange({ email: e.target.value })} />
        </Field>
      </div>

      <Field label="Exact address of the factory" required={need} error={errors.address} htmlFor="v-address"
             hint="Plot / building, road, landmark — as someone would need it to find the place">
        <textarea id="v-address" className={`${s.textarea}${errors.address ? ` ${s.invalid}` : ''}`} value={value.address}
                  maxLength={500} onChange={e => onChange({ address: e.target.value })} />
      </Field>
      <div className={s.grid2}>
        <Field label="City" required={need} error={errors.city} htmlFor="v-city">
          <input id="v-city" className={cls('city')} value={value.city} maxLength={80}
                 onChange={e => onChange({ city: e.target.value })} />
        </Field>
        <Field label="State" htmlFor="v-state">
          <input id="v-state" className={s.input} value={value.state} maxLength={80}
                 onChange={e => onChange({ state: e.target.value })} />
        </Field>
        <Field label="Pincode" error={errors.pincode} htmlFor="v-pin">
          <input id="v-pin" className={cls('pincode')} value={value.pincode} inputMode="numeric" maxLength={6}
                 onChange={e => onChange({ pincode: e.target.value })} />
        </Field>
      </div>

      <Field label="What can this vendor do?" required={need} error={errors.capabilities}>
        <Chips multiple label="What this vendor can do" options={CAPABILITIES} value={value.capabilities}
               onChange={v => onChange({ capabilities: v as string[] })} />
      </Field>
      <Field label="Product types">
        <Chips multiple label="Product types" options={CATEGORIES} value={value.categories}
               onChange={v => onChange({ categories: v as string[] })} />
      </Field>
      <div className={s.grid2}>
        <Field label="Materials worked with" htmlFor="v-mat" hint="Teak, sheesham, MS, fabric…">
          <input id="v-mat" className={s.input} value={value.materials} maxLength={300}
                 onChange={e => onChange({ materials: e.target.value })} />
        </Field>
        <Field label="Number of people" error={errors.headcount} htmlFor="v-head" hint="Everyone working at the unit">
          <input id="v-head" className={cls('headcount')} value={value.headcount} inputMode="numeric" maxLength={4}
                 onChange={e => onChange({ headcount: e.target.value })} />
        </Field>
        <Field label="Monthly capacity" htmlFor="v-cap" hint="For example: 40 sofas or 200 chairs a month">
          <input id="v-cap" className={s.input} value={value.monthly_capacity} maxLength={200}
                 onChange={e => onChange({ monthly_capacity: e.target.value })} />
        </Field>
      </div>
      <Field label="Who recommended them / how we heard of them" htmlFor="v-ref"
             hint="Name the person or company that gave us this reference, so it can be followed up">
        <input id="v-ref" className={s.input} value={value.referred_by} maxLength={200}
               onChange={e => onChange({ referred_by: e.target.value })} />
      </Field>
      <Field label="Notes about the vendor" htmlFor="v-notes">
        <textarea id="v-notes" className={s.textarea} value={value.notes} maxLength={2000}
                  onChange={e => onChange({ notes: e.target.value })} />
      </Field>
    </>
  )
}
