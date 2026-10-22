/* Shared sidebar brand mark — the BOE One app icon. Empty alt: "BOE One" is the visible text beside it. */
export function BoeBrandIcon() {
  return (
    <div className="boe-sidebar-brand-icon">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/svg/boe-one-app-icon.svg"
        alt=""
        width={40}
        height={40}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}
