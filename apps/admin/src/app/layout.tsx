import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Candila TradeSync',
  description: 'Candila TradeSync — Enterprise Multi-Broker Copy Trading Platform. Powered by Candila FinTech.',
  icons: { icon: '/candila-fintech-logo.webp', shortcut: '/candila-fintech-logo.webp', apple: '/candila-fintech-logo.webp' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
