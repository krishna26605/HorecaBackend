// src/app/layout.js (or src/app/layout.tsx)
import { SessionProvider } from '@/context/SessionContext';
import './globals.css'; // Import your global styles here
export const metadata = {
  title: 'SupplyChainPro',
  description: 'Business Management Suite',
};
//sampple
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <SessionProvider>
        <body>{children}</body>
      </SessionProvider>
    </html>
  );
}