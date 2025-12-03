import './globals.css';

import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata = {
  title: 'conf-ts Playground',
  description: 'Interactive playground for conf-ts',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark h-full ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="h-full bg-[#050505] text-neutral-200 antialiased overflow-hidden font-sans selection:bg-white/10">
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}
