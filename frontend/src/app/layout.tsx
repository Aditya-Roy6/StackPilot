import type { Metadata } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import Providers from "@/lib/providers";
import { UI_THEME_INIT_SCRIPT } from "@/lib/ui-theme";
import { ICON_INIT_SCRIPT } from "@/lib/custom-icons";
import { Toaster } from "@/components/ui/sonner";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "StackPilot | AI Application Delivery Cockpit",
  description: "AI-assisted application delivery cockpit for Docker, Kubernetes, source projects, and ready-to-run application templates.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plusJakartaSans.variable} ${jetBrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <Script
          id="stackpilot-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `${UI_THEME_INIT_SCRIPT}\n${ICON_INIT_SCRIPT}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
