"use client";

// Deliberately duplicated from the true root `error.tsx`, not shared via
// import. An error boundary unmounts everything below the layout where it's
// defined; without a copy here, an error thrown by any `(dashboard)` page
// would bubble to the root `error.tsx` and take `(dashboard)/layout.tsx`'s
// `NavBar` down with it. Keeping a copy at this level means `NavBar` stays
// mounted (matching pre-restructuring behavior) when a dashboard page errors.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Something went wrong</h1>
      </div>
      <div className="error-banner">{error.message || "An unexpected error occurred."}</div>
      <button type="button" className="btn" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
