import Link from "next/link";
import {
  ApiError,
  listResearchHypotheses,
  type HypothesisConfidence,
  type ResearchHypothesis,
  type ResearchHypothesisStatus,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/**
 * This route lives at /research/hypotheses rather than /research itself:
 * /research is already the Milestone 1 backtest research page (run
 * backtests, browse them - see apps/dashboard/src/app/(dashboard)/research/
 * page.tsx and its [backtestId] detail route). Reusing /research for the
 * Milestone 7 hypothesis list would either silently delete that page or
 * collide with [backtestId]'s dynamic segment, so hypotheses get their own
 * static sub-route instead, coexisting with [backtestId] the same way
 * /research/[backtestId]/trades does.
 */

const HYPOTHESIS_STATUS_CLASS: Record<ResearchHypothesisStatus, string> = {
  PROPOSED: "badge--neutral",
  EXPERIMENT_QUEUED: "badge--queued",
  IN_PROGRESS: "badge--running",
  VALIDATED: "badge--success",
  REJECTED: "badge--danger",
  ABANDONED: "badge--neutral",
};

const HYPOTHESIS_CONFIDENCE_CLASS: Record<HypothesisConfidence, string> = {
  LOW: "badge--neutral",
  MEDIUM: "badge--info",
  HIGH: "badge--success",
};

export default async function ResearchHypothesesPage() {
  let hypotheses: ResearchHypothesis[] = [];
  let loadError: string | null = null;

  try {
    hypotheses = await listResearchHypotheses();
  } catch (err) {
    loadError = err instanceof ApiError ? err.message : "Failed to load research hypotheses.";
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Research Hypotheses</h1>
        <p>
          AI-generated, schema-validated hypotheses derived from deterministic journal statistics. The AI
          never calculates a P&amp;L or risk number and never modifies an approved strategy version; a
          human always decides what happens with a result. See <code>docs/ai-research.md</code> for the
          pipeline these move through.
        </p>
      </div>

      <div className="card">
        {loadError && <div className="error-banner">{loadError}</div>}

        {!loadError && hypotheses.length === 0 && (
          <div className="empty-state">No hypotheses yet.</div>
        )}

        {!loadError && hypotheses.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Confidence</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {hypotheses.map((hypothesis) => (
                  <tr key={hypothesis.id}>
                    <td>
                      <Link href={`/research/hypotheses/${hypothesis.id}`}>{hypothesis.title}</Link>
                    </td>
                    <td>
                      <span className={`badge ${HYPOTHESIS_STATUS_CLASS[hypothesis.status]}`}>
                        {hypothesis.status}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${HYPOTHESIS_CONFIDENCE_CLASS[hypothesis.confidence]}`}>
                        {hypothesis.confidence}
                      </span>
                    </td>
                    <td>{formatDateTime(hypothesis.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
