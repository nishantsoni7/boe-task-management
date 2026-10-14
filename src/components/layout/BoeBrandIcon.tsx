/* Shared sidebar brand mark — the BOE symbol, unframed, at a readable size. */
export function BoeBrandIcon() {
  return (
    <div className="boe-sidebar-brand-icon">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/branding/boe-icon.png"
        alt=""
        width={40}
        height={40}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}
