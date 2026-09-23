import Link from "next/link";

// Deliberately duplicated from the true root `not-found.tsx`, not shared via
// import. Several pages inside the `(dashboard)` route group call Next's
// `notFound()` (research/[backtestId], strategies/[strategyId],
// webhook-events/[id], setups/[id], trades/[id],
// analytics/[strategyId]/[versionId]) - that bubbles to the nearest
// `not-found.tsx` in the rendered layout tree, which is this one, so those
// pages keep rendering with `NavBar` (via `(dashboard)/layout.tsx`), exactly
// as before this route-group restructuring. The true root `not-found.tsx`
// remains as the fallback for a genuinely unmatched path outside any known
// route (e.g. a typo'd URL with no matching segment at all).
export default function NotFound() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Not found</h1>
        <p>That resource does not exist.</p>
      </div>
      <Link href="/research">Back to Research</Link>
    </div>
  );
}
