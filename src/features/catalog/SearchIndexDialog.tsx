import type { AnalysisMode, SearchIndexEstimate } from "../../lib/contracts";
import { formatUsd } from "../../lib/presentation";

export function SearchIndexDialog({
  mode,
  estimate,
  estimating,
  onModeChange,
  onCancel,
  onConfirm,
}: {
  mode: AnalysisMode;
  estimate: SearchIndexEstimate | null;
  estimating: boolean;
  onModeChange: (mode: AnalysisMode) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const estimatedCost = mode === "fast" ? estimate?.fastCostUsd : estimate?.batchCostUsd;

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="Choose search indexing mode" className="modal-card search-index-dialog">
        <div>
          <span className="eyebrow">Semantic search index</span>
          <h2>Choose indexing speed</h2>
          <p>
            Both modes create the same search index. Only completion time and
            embedding cost change.
          </p>
        </div>
        <fieldset className="analysis-mode-picker">
          <legend>Processing mode</legend>
          <label className={mode === "batch" ? "selected" : ""}>
            <input
              checked={mode === "batch"}
              name="search-index-mode"
              onChange={() => onModeChange("batch")}
              type="radio"
            />
            <span>
              <strong>Batch (default)</strong>
              <small>Lowest cost; can take several hours.</small>
            </span>
          </label>
          <label className={mode === "fast" ? "selected" : ""}>
            <input
              checked={mode === "fast"}
              name="search-index-mode"
              onChange={() => onModeChange("fast")}
              type="radio"
            />
            <span>
              <strong>Fast mode</strong>
              <small>Standard requests; usually much faster at about 2× the API cost.</small>
            </span>
          </label>
        </fieldset>
        <div className="cost-callout search-index-cost">
          <div>
            <span>Approximate Gemini cost</span>
            <strong>
              {estimating ? "Calculating…" : estimatedCost === undefined
                ? "Unavailable"
                : formatUsd(estimatedCost)}
            </strong>
          </div>
          <p>
            {estimate
              ? `${estimate.totalRecords.toLocaleString()} searchable records and approximately ${estimate.estimatedTokens.toLocaleString()} embedding tokens.`
              : "Docubase is counting the current clip summaries, visual moments, and transcript passages."}
          </p>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={estimating || !estimate}
            onClick={onConfirm}
            type="button"
          >
            Build in {mode === "fast" ? "Fast" : "Batch"} mode
          </button>
        </div>
      </section>
    </div>
  );
}
