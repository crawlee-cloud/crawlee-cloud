import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Crawlee Platform",
  description: "Self-hosted Apify-compatible platform for web scraping",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full" suppressHydrationWarning>
      <body className={cn(inter.className, "bg-background text-foreground antialiased h-full")}>
        <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
          <div className="flex h-full min-h-screen">
            <Sidebar />
            <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
              <Header />
              <main className="flex-1 overflow-auto p-6 md:p-8">
                {children}
              </main>
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
