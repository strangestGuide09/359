import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Grocery Ledger — Shared bills, smarter restocks",
  description: "A privacy-first, browser-only ledger for shared groceries, bills, balances, and possible buys.",
  openGraph: {
    title: "Grocery Ledger",
    description: "Shared bills. Smarter restocks.",
    images: [{ url: "/og.png", width: 1792, height: 1024, alt: "Grocery Ledger" }],
  },
  twitter: { card: "summary_large_image", title: "Grocery Ledger", description: "Shared bills. Smarter restocks.", images: ["/og.png"] },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
