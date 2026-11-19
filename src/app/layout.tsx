import "./globals.css";

import { cookies } from "next/headers";

import { THEME_COOKIE, parseTheme } from "@/lib/ui/theme";

export const metadata = {
  title: "Petrosil Platform",
  description: "One admin for the whole estate.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Light or dark, as chosen with the switch; absent, the stylesheets follow
  // the computer's setting. Set here so the first paint is already right.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    // The switch changes data-theme in the browser without a reload.
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
