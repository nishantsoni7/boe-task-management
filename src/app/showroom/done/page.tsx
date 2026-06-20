// Static public thank-you page. No auth, no actions, no sessionStorage access.
export default function DonePage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#F4F5F7',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '24px 16px 48px',
    }}>
      {/* BOE header */}
      <div style={{
        width: '100%', maxWidth: '480px',
        display: 'flex', alignItems: 'center', gap: '8px',
        marginBottom: '20px',
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: '6px', background: '#1A2035',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#DC1F2E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <span style={{ fontSize: '12px', fontWeight: 700, color: '#4A5261', letterSpacing: '0.02em' }}>
          BOE Showroom
        </span>
      </div>

      {/* Card */}
      <div style={{
        width: '100%', maxWidth: '480px',
        background: '#FFFFFF',
        border: '1.5px solid rgba(0,0,0,0.08)',
        borderRadius: '16px',
        padding: '40px 24px 44px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.05)',
        textAlign: 'center',
      }}>
        {/* Check icon */}
        <div style={{
          width: 60, height: 60, borderRadius: '50%',
          background: 'rgba(69,168,112,0.10)',
          border: '2px solid rgba(69,168,112,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#45A870" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h1 style={{
          fontFamily: 'var(--font-display, Syne, sans-serif)',
          fontSize: '22px', fontWeight: 700,
          color: '#111318',
          margin: '0 0 12px', letterSpacing: '-0.02em',
        }}>
          Thank You
        </h1>

        <p style={{
          fontSize: '14px', color: '#4A5261',
          lineHeight: 1.65, margin: 0,
          maxWidth: '300px', marginInline: 'auto',
        }}>
          Your selected products have been shared with our sales team.
        </p>
      </div>
    </div>
  )
}
