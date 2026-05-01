import type { Metadata } from 'next';
import { JetBrains_Mono, Inter_Tight } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { cn } from '@/lib/utils';

const sans = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Crawlee Cloud — Operator Console',
  description: 'Self-hosted Apify-compatible platform for web scraping',
  icons: {
    // SVG favicon — sharp at every density, brand-consistent.
    icon: [{ url: '/logo-icon.svg', type: 'image/svg+xml' }],
    // iOS home-screen icon — 210×210 PNG.
    apple: [{ url: '/apple-touch-icon.png', sizes: '210x210', type: 'image/png' }],
    // Fallback for legacy browsers that reject SVG favicons.
    shortcut: [{ url: '/logo-icon.svg' }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body
        className={cn(
          sans.variable,
          mono.variable,
          'bg-background text-foreground antialiased h-full font-sans'
        )}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
