import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trading Copilot",
  description: "Personal trading research and decision-support dashboard.",
};

/**
 * True root layout. Kept deliberately bare - `<html>`/`<body>`, global CSS,
 * and nothing else that renders visible chrome. Site navigation (`NavBar`)
 * lives one level down, in `(dashboard)/layout.tsx`, so that
 * `apps/dashboard/src/app/internal/*` (Playwright-only chart render routes,
 * captured at a fixed viewport with no site chrome) can render under this
 * layout alone, without inheriting anything from the `(dashboard)` route
 * group.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
