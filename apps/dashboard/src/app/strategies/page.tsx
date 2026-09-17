import Link from "next/link";
import { ApiError, getStrategies } from "@/lib/api";
import { formatDate } from "@/lib/format";

export default async function StrategiesPage() {
  let strategies: Awaited<ReturnType<typeof getStrategies>> = [];
  let loadError: string | null = null;

  try {
    strategies = await getStrategies();
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load strategies.";
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Strategies</h1>
        <p>Deterministic strategy definitions, versioned so nothing is silently changed.</p>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      {!loadError && strategies.length === 0 && (
        <div className="empty-state">No strategies found.</div>
      )}

      {!loadError && strategies.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Description</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr key={strategy.id}>
                  <td>
                    <Link href={`/strategies/${strategy.id}`}>{strategy.key}</Link>
                  </td>
                  <td>{strategy.name}</td>
                  <td>{strategy.description ?? "N/A"}</td>
                  <td>{formatDate(strategy.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
