import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Database Architect',
  description:
    'Describe a domain in natural language and get a live relational backend: schema, CRUD APIs, auth, and an admin dashboard.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="brand">
            <span className="brand-mark">🗄️</span>
            <div>
              <h1>AI Database Architect</h1>
              <p className="tagline">
                Describe, upload, or import &rarr; a live AWS backend with CRUD
                APIs and an admin dashboard.
              </p>
            </div>
          </div>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
