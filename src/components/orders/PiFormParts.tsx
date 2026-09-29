// Small presentational parts shared by the PI Draft's forms: a label above the
// control, a restrained red star for what Submit for approval needs, one line of
// help, and the field's own error. No state and no rules — every requirement is
// decided by piCompletion.ts and the database, and drawn here as `required`.

export const REQUIRED_LEGEND = 'Required to submit for approval'

/** The one explanation of the star, drawn once at the top of a form. */
export function RequiredLegend() {
  return (
    <p className="pi-form-legend">
      <span className="pi-form-req" aria-hidden="true">*</span> {REQUIRED_LEGEND}
    </p>
  )
}

/** The star itself. Hidden from a screen reader: `aria-required` on the control says it. */
export function RequiredMark() {
  return <span className="pi-form-req" aria-hidden="true">*</span>
}

export function FormGroup({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="pi-form-group" aria-label={title}>
      <div className="pi-form-group-head">
        <h3 className="pi-form-group-title">{title}</h3>
        {note && <p className="pi-form-group-note">{note}</p>}
      </div>
      {children}
    </section>
  )
}

/** A top-aligned label, the control, one line of help, and the error. */
export function FormField({ id, label, required = false, optional = false, help, error, children }: {
  id: string
  label: string
  required?: boolean
  optional?: boolean
  help?: React.ReactNode
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="pi-form-field">
      <label htmlFor={id} className="pi-form-label">
        {label}
        {required && <RequiredMark />}
        {optional && <span className="pi-form-optional">Optional</span>}
      </label>
      {children}
      {help && <span id={`${id}-help`} className="pi-form-help">{help}</span>}
      {error && <span id={`${id}-error`} role="alert" className="pi-form-error">{error}</span>}
    </div>
  )
}

/** `aria-describedby` for a control drawn by FormField: its help and, when there is one, its error. */
export function describedBy(id: string, hasHelp: boolean, hasError: boolean): string | undefined {
  const ids = [hasHelp ? `${id}-help` : null, hasError ? `${id}-error` : null].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
}

/**
 * A choice group: one legend, and options as comfortable cards. A real fieldset
 * with radios in it, so arrow keys, the group name and the checked state come
 * from the platform. Nothing is checked until the person chooses.
 */
export function ChoiceGroup({ legend, required = false, help, error, describedById, children }: {
  legend: string
  required?: boolean
  help?: React.ReactNode
  error?: string | null
  describedById: string
  children: React.ReactNode
}) {
  return (
    <fieldset
      className="pi-form-choice-group"
      role="radiogroup"
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(describedById, Boolean(help), Boolean(error))}
    >
      <legend className="pi-form-label">
        {legend}
        {required && <RequiredMark />}
      </legend>
      {help && <span id={`${describedById}-help`} className="pi-form-help">{help}</span>}
      <div className="pi-form-choices">{children}</div>
      {error && <span id={`${describedById}-error`} role="alert" className="pi-form-error">{error}</span>}
    </fieldset>
  )
}

export function Choice({ id, name, label, checked, disabled, onChange }: {
  id?: string
  name: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <label className="pi-form-choice" data-checked={checked ? 'true' : 'false'}>
      <input id={id} type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span>{label}</span>
    </label>
  )
}
