import type { Metadata, Viewport } from 'next'
import { Source_Sans_3 } from 'next/font/google'
import './globals.css'
import { TabBar } from '@/components/TabBar'
import { RegisterServiceWorker } from '@/components/RegisterServiceWorker'
import { SessionState } from '@/components/SessionState'
import { t } from '@/i18n/pl'

// Self-hosted at build time by next/font. Cyrillic for the Russian prompts,
// latin-ext for Polish diacritics.
const sans = Source_Sans_3({ subsets: ['latin', 'latin-ext', 'cyrillic'], display: 'swap', variable: '--font-source-sans' })

export const metadata: Metadata = { title: t.appName, manifest: '/manifest.webmanifest' }
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={sans.variable}>
      <body className="mx-auto max-w-xl">
        <main className="pad-below-tabbar px-4 pt-4">
          <SessionState>{children}</SessionState>
        </main>
        <TabBar />
        <RegisterServiceWorker />
      </body>
    </html>
  )
}
