import { notFound } from "next/navigation";
import Link from "next/link";
import { ApiError, getResearchHypothesis } from "@/lib/api";
import { formatCurrency, formatDate, formatDateTime, formatInteger } from "@/lib/format";
import {
  AgentExecutionStatusBadge,
  HypothesisConfidenceBadge,
  HypothesisStatusBadge,
  ResearchExperimentStatusBadge,
} from "@/components/StatusBadge";

export default async function ResearchHypothesisDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail;
  try {
    detail = await getResearchHypothesis(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    const message = err instanceof ApiError ? err.message : "Failed to load research hypothesis.";
    return (
      <div className="page">
        <div className="page-header">
          <h1>Research Hypothesis</h1>
        </div>
        <div className="error-banner">{message}</div>
      </div>
    );
  }

  const { hypothesis, experiments, agentExecution } = detail;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{hypothesis.title}</h1>
        <p className="muted">
          <Link href="/research/hypotheses">&larr; back to research hypotheses</Link>
        </p>
      </div>

      <div className="card">
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Status</div>
            <div className="detail-item__value">
              <HypothesisStatusBadge status={hypothesis.status} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Confidence</div>
            <div className="detail-item__value">
              <HypothesisConfidenceBadge confidence={hypothesis.confidence} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Created</div>
            <div className="detail-item__value">{formatDateTime(hypothesis.createdAt)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Statement</h2>
        <p>{hypothesis.statement}</p>
      </div>

      <div className="card">
        <h2>Rationale</h2>
        <p>{hypothesis.rationale}</p>
      </div>

      <div className="card">
        <h2>Proposed StrategyDefinition</h2>
        <pre className="params">{JSON.stringify(hypothesis.proposedStrategyDefinition, null, 2)}</pre>
      </div>

      <div className="card">
        <h2>Source Data Summary</h2>
        <pre className="params">{JSON.stringify(hypothesis.sourceDataSummary, null, 2)}</pre>
      </div>

      <div className="card">
        <h2>Experiment History</h2>
        {experiments.length === 0 ? (
          <div className="empty-state">No experiments yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dataset Role</th>
                  <th>Window</th>
                  <th>Status</th>
                  <th>Backtest</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((experiment) => (
                  <tr key={experiment.id}>
                    <td>{experiment.datasetRole}</td>
                    <td>
                      {formatDate(experiment.datasetWindowStart)} to{" "}
                      {formatDate(experiment.datasetWindowEnd)}
                    </td>
                    <td>
                      <ResearchExperimentStatusBadge status={experiment.status} />
                      {experiment.failureReason ? `: ${experiment.failureReason}` : ""}
                    </td>
                    <td>
                      {experiment.backtestId ? (
                        <Link href={`/research/${experiment.backtestId}`}>view backtest</Link>
                      ) : (
                        "N/A"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Agent Execution Audit</h2>
        <div className="detail-grid">
          <div className="detail-item">
            <div className="detail-item__label">Provider</div>
            <div className="detail-item__value">{agentExecution.provider}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Model</div>
            <div className="detail-item__value">{agentExecution.model}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Prompt Version</div>
            <div className="detail-item__value">{agentExecution.promptVersion}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Status</div>
            <div className="detail-item__value">
              <AgentExecutionStatusBadge status={agentExecution.status} />
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Tokens (in / out)</div>
            <div className="detail-item__value">
              {formatInteger(agentExecution.tokensInput)} / {formatInteger(agentExecution.tokensOutput)}
            </div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Cost</div>
            <div className="detail-item__value">{formatCurrency(agentExecution.costUsd)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Started</div>
            <div className="detail-item__value">{formatDateTime(agentExecution.startedAt)}</div>
          </div>
          <div className="detail-item">
            <div className="detail-item__label">Completed</div>
            <div className="detail-item__value">{formatDateTime(agentExecution.completedAt)}</div>
          </div>
        </div>

        <details>
          <summary>Raw provider response</summary>
          <pre className="params">{agentExecution.outputRaw ?? "(none)"}</pre>
        </details>
      </div>
    </div>
  );
}
