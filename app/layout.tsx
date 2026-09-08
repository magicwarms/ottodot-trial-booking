import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ottodot — Trial Booking',
  description: 'Trial class booking with reliable seat and payment handling.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>
          <nav>
            <a href="/">Book a trial</a>
            <a href="/roster">Roster</a>
            <a href="/api/roster">Roster API</a>
          </nav>
          {children}
        </main>
      </body>
    </html>
  );
}
