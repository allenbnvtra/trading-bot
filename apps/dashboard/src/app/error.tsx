"use client";

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
