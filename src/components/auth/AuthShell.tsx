import { colors, font } from '@/lib/tokens'

// The signed-out frame: BOE One wordmark, one card, the internal-use footer. Sign in,
// Forgot password and Reset password all sit in it, so moving between them
// changes only the card.
export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: colors.void,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 16px',
    }}>
      <div style={{ width: '100%', maxWidth: '360px' }}>

        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1 style={{
            fontFamily: font.display,
            fontWeight: 700,
            fontSize: '36px',
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            marginBottom: '12px',
            color: colors.brand,
          }}>
            BOE <span style={{ color: colors.brandInk }}>One</span>
          </h1>
          <p style={{ color: colors.tertiary, fontSize: '12.5px', lineHeight: 1.5 }}>
            Tasks, follow-ups, accountability, and daily work tracking for the BOE team.
          </p>
        </div>

        {/* Form card */}
        <div className="boe-card" style={{ padding: '24px' }}>
          <h2 style={{
            color: colors.primary,
            fontFamily: font.display,
            fontWeight: 600,
            fontSize: '16px',
            marginBottom: '20px',
          }}>
            {title}
          </h2>
          {children}
        </div>

        <p style={{
          textAlign: 'center',
          color: colors.muted,
          fontSize: '11px',
          marginTop: '20px',
        }}>
          Best of Exports — Internal use only
        </p>

      </div>
    </div>
  )
}

/** Full-width primary action inside the auth card. */
export const authButtonStyle: React.CSSProperties = {
  width: '100%',
  justifyContent: 'center',
  padding: '12px',
  fontSize: '14px',
}

/** Small text link under the auth card's button ("Forgot password?", "Back to sign in"). */
export const authLinkStyle: React.CSSProperties = {
  display: 'block',
  textAlign: 'center',
  marginTop: '14px',
  fontSize: '12.5px',
  color: colors.brand,
  textDecoration: 'none',
  fontWeight: 500,
}
