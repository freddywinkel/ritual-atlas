import type { Metadata, Viewport } from "next";
import { PUBLIC_BASE_PATH, publicPath } from "./lib/publicPath";
import "./globals.css";

const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "http://localhost:3000";
const siteUrl = new URL(PUBLIC_BASE_PATH ? `${PUBLIC_BASE_PATH}/` : "/", siteOrigin);
const socialImage = new URL(publicPath("/og.jpg"), siteOrigin).toString();
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "Ritual Atlas",
    template: "%s · Ritual Atlas",
  },
  description:
    "A private, bilingual tarot and oracle reading journal for physical card pulls.",
  applicationName: "Ritual Atlas",
  manifest: publicPath("/manifest.webmanifest"),
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Ritual Atlas",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: publicPath("/favicon.png"), sizes: "64x64", type: "image/png" },
      { url: publicPath("/icon-192.png"), sizes: "192x192", type: "image/png" },
    ],
    apple: [
      {
        url: publicPath("/apple-touch-icon.png"),
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  openGraph: {
    type: "website",
    title: "Ritual Atlas",
    description: "A private journal for physical tarot and oracle readings.",
    images: [{ url: socialImage, width: 1600, height: 840, alt: "Ritual Atlas" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ritual Atlas",
    description: "A private journal for physical tarot and oracle readings.",
    images: [socialImage],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#03151c",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy} />
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>{children}</body>
    </html>
  );
}
