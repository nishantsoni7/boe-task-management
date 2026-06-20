/* Shared sidebar brand icon — BOE red mark in a clean white container */
export function BoeBrandIcon() {
  return (
    <div style={{
      width: '36px', height: '36px', flexShrink: 0,
      borderRadius: '9px', background: '#ffffff',
      border: '1px solid #E5E7EB',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '4px', boxSizing: 'border-box',
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/branding/boe-icon.png"
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}
