// app/layout.tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Christy – BTC Mining Agent",
  description:
    "Chat with Christy Solberg about Bitcoin mining hardware, hosting and ROI.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
