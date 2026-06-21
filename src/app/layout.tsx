import type { Metadata } from 'next'
import { Syne, DM_Sans, DM_Mono, Inter } from 'next/font/google'
import { Providers } from '@/components/layout/Providers'
import './globals.css'

const syne = Syne({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
})

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
})

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'BOE Operating System',
  description: 'Best of Exports — Internal Operating System',
  manifest: '/manifest.json',
  icons: {
    icon: '/branding/favicon.png',
    apple: '/branding/favicon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BOE Operating System',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${syne.variable} ${dmSans.variable} ${dmMono.variable} ${inter.variable}`}
    >
      <body style={{ fontFamily: 'var(--font-body, DM Sans, sans-serif)' }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}