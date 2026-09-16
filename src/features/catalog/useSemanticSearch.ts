import { useCallback, useEffect, useState } from "react";
import {
  cancelSearchIndex,
  estimateSearchIndex,
  getSearchIndexStatus,
  refreshSearchIndex,
  searchProject,
  startSearchIndex,
} from "../../lib/cloud";
import type {
  AnalysisMode,
  SearchIndexEstimate,
  SearchIndexStatus,
  SearchScope,
  SemanticSearchResult,
} from "../../lib/contracts";
import { readableError } from "../../lib/presentation";
import type { CatalogNotice } from "./types";

export function useSemanticSearch(
  projectId: string,
  setNotice: (notice: CatalogNotice | null) => void,
) {
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [scope, setScope] = useState<SearchScope>("all");
  const [results, setResults] = useState<SemanticSearchResult[]>([]);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexMode, setIndexMode] = useState<AnalysisMode>("batch");
  const [canceling, setCanceling] = useState(false);
  const [estimate, setEstimate] = useState<SearchIndexEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getSearchIndexStatus(projectId));
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    }
  }, [projectId, setNotice]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!indexing) return;
    const timer = window.setInterval(() => void loadStatus(), 2_000);
    return () => window.clearInterval(timer);
  }, [indexing, loadStatus]);

  useEffect(() => {
    if (!status || !["pending", "running"].includes(status.state)) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        await refreshSearchIndex(projectId);
        const next = await getSearchIndexStatus(projectId);
        if (!cancelled) setStatus(next);
      } catch (error) {
        if (!cancelled) {
          setNotice({ tone: "error", message: readableError(error) });
        }
      }
    };
    const timer = window.setInterval(() => void refresh(), 10_000);
    void refresh();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, setNotice, status?.jobId, status?.state]);

  const buildIndex = useCallback(async (mode: AnalysisMode) => {
    setIndexing(true);
    setIndexMode(mode);
    setNotice(null);
    try {
      await startSearchIndex(projectId, mode);
      const next = await getSearchIndexStatus(projectId);
      setStatus(next);
      setResults([]);
      setSubmittedQuery("");
      if (next.state === "complete") {
        setNotice({ tone: "success", message: "Search index is ready." });
      }
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setIndexing(false);
    }
  }, [projectId, setNotice]);

  const runSearch = useCallback(async (query: string) => {
    const normalized = query.trim();
    if (normalized.length < 2 || status?.state !== "complete") return;
    setSearching(true);
    setNotice(null);
    try {
      const response = await searchProject(projectId, normalized, scope);
      setResults(response.results);
      setSubmittedQuery(response.query);
      await loadStatus();
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setSearching(false);
    }
  }, [loadStatus, projectId, scope, setNotice, status?.state]);

  const cancelIndex = useCallback(async () => {
    setCanceling(true);
    setNotice(null);
    try {
      await cancelSearchIndex(projectId);
      setStatus(await getSearchIndexStatus(projectId));
      setResults([]);
      setSubmittedQuery("");
      setNotice({ tone: "success", message: "Search indexing canceled and reset." });
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setCanceling(false);
    }
  }, [projectId, setNotice]);

  const prepareIndex = useCallback(async () => {
    setEstimate(null);
    setEstimating(true);
    setNotice(null);
    try {
      setEstimate(await estimateSearchIndex(projectId));
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setEstimating(false);
    }
  }, [projectId, setNotice]);

  return {
    buildIndex,
    cancelIndex,
    canceling,
    estimate,
    estimating,
    indexMode,
    indexing,
    prepareIndex,
    results,
    runSearch,
    scope,
    searching,
    setScope,
    setIndexMode,
    status,
    submittedQuery,
  };
}
