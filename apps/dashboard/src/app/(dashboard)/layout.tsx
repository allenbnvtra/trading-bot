import NavBar from "@/components/NavBar";

/**
 * Layout for the `(dashboard)` route group - every normal, human-facing page
 * in the app (Dashboard home, Research, Strategies, Backtests, Market Data,
 * Journal, Trades, Analytics, Live Setups, Setups, Webhook Events). Route
 * groups (the parenthesized folder name) don't add a URL segment, so every
 * page under here keeps its original path (e.g. `(dashboard)/live-setups`
 * still serves `/live-setups`).
 *
 * `NavBar` lives here, not in the true root layout
 * (`apps/dashboard/src/app/layout.tsx`), specifically so it does NOT wrap
 * `apps/dashboard/src/app/internal/*` - those are Playwright-only chart
 * render routes that must produce a bare, chrome-free page at an exact pixel
 * size. Next.js layouts nest strictly inside their parent, so keeping
 * `NavBar` in the true root layout would have made it impossible for
 * `internal/*` to opt out of it.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <NavBar />
      {children}
    </>
  );
}
