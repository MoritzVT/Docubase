import {
  INTERVIEW_ROUTING,
  TRANSCRIPT_REQUEST_MAX_BYTES,
  TRANSCRIPT_REQUEST_MAX_ESTIMATED_TOKENS,
  TRANSCRIPT_SECTION_MAX_CHARACTERS,
  arrayStrings,
  numeric,
  requirePlainRecord,
  type TranscriptAnalysis,
  type TranscriptEvidence,
  type TranscriptSpeechFormat,
  type VisualComposition,
  type VisualRoutingAnalysis,
} from "./shared.js";

const GENERIC_KEYWORDS = new Set([
  "documentary",
  "footage",
  "person",
  "people",
  "video",
  "clip",
  "scene",
]);

export interface TranscriptSection {
  index: number;
  utterances: TranscriptEvidence[];
  text: string;
  estimatedTokens: number;
  byteLength: number;
}

export interface VisualStability {
  significantChangeCount: number;
  significantChangeRatio: number;
  medianChangeScore: number;
  maximumChangeScore: number;
}

export interface MergedClipAnalysis {
  description: string;
  tags: string[];
  generatedTranscriptTags: string[];
  generatedVisualTags: string[];
  keywordProvenance: Array<{
    value: string;
    sources: Array<"transcript" | "visual">;
    evidenceUtteranceIds: string[];
    evidenceFrameIds: string[];
  }>;
}

export function transcriptLine(utterance: TranscriptEvidence): string {
  const speaker =
    utterance.speaker === null ? "Speaker" : `Speaker ${utterance.speaker + 1}`;
  return `[${utterance.id}] ${utterance.startMs}-${utterance.endMs} ms ${speaker}: ${utterance.text.trim()}`;
}

export function partitionCompleteTranscript(
  utterances: TranscriptEvidence[],
  maxCharacters = TRANSCRIPT_SECTION_MAX_CHARACTERS,
  maxBytes = TRANSCRIPT_REQUEST_MAX_BYTES,
  maxEstimatedTokens = TRANSCRIPT_REQUEST_MAX_ESTIMATED_TOKENS,
): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  let current: TranscriptEvidence[] = [];
  let currentLines: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = currentLines.join("\n");
    sections.push({
      index: sections.length,
      utterances: current,
      text,
      estimatedTokens: Math.ceil(text.length / 4),
      byteLength: Buffer.byteLength(text, "utf8"),
    });
    current = [];
    currentLines = [];
  };

  for (const utterance of utterances
    .filter((item) => item.text.trim().length > 0)
    .sort((left, right) => left.startMs - right.startMs)) {
    const line = transcriptLine(utterance);
    const proposedText = [...currentLines, line].join("\n");
    const exceedsLimit =
      current.length > 0 &&
      (proposedText.length > maxCharacters ||
        Buffer.byteLength(proposedText, "utf8") > maxBytes ||
        Math.ceil(proposedText.length / 4) > maxEstimatedTokens);
    if (exceedsLimit) flush();
    current.push(utterance);
    currentLines.push(line);
  }
  flush();
  return sections;
}

export function normalizeKeywords(values: string[], limit = 24): string[] {
  const result: string[] = [];
  const normalized = new Set<string>();
  for (const value of values) {
    const keyword = value.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/g, "");
    const key = keyword.toLocaleLowerCase();
    if (
      !keyword ||
      keyword.length > 80 ||
      GENERIC_KEYWORDS.has(key) ||
      normalized.has(key)
    ) {
      continue;
    }
    normalized.add(key);
    result.push(keyword);
    if (result.length >= limit) break;
  }
  return result;
}

export function sanitizeTranscriptAnalysis(
  value: unknown,
  allowedUtteranceIds: string[],
): TranscriptAnalysis {
  const record = requirePlainRecord(value, "transcript analysis");
  const formats: TranscriptSpeechFormat[] = [
    "interview",
    "conversation",
    "narration",
    "presentation",
    "production-chatter",
    "no-substantive-speech",
    "mixed",
    "unknown",
  ];
  const speechFormat = formats.includes(
    record.speechFormat as TranscriptSpeechFormat,
  )
    ? (record.speechFormat as TranscriptSpeechFormat)
    : "unknown";
  const evidenceUtteranceIds = uniqueAllowedIds(
    arrayStrings(record.evidenceUtteranceIds),
    allowedUtteranceIds,
  );
  if (allowedUtteranceIds.length > 0 && evidenceUtteranceIds.length === 0) {
    throw new Error("The transcript analysis did not cite a supplied utterance.");
  }
  const summary = limitWordsAndSentences(String(record.summary ?? ""), 55, 2);
  if (!summary && speechFormat !== "no-substantive-speech") {
    throw new Error("The transcript analysis summary is empty.");
  }
  return {
    summary,
    speechFormat,
    subjects: normalizeKeywords(arrayStrings(record.subjects), 12),
    keywords: normalizeKeywords(arrayStrings(record.keywords), 15),
    namedEntities: normalizeKeywords(arrayStrings(record.namedEntities), 20),
    evidenceUtteranceIds,
    confidence: boundedConfidence(record.confidence),
  };
}

export function sanitizeVisualRoutingAnalysis(
  value: unknown,
  allowedFrameIds: string[],
): VisualRoutingAnalysis {
  const record = requirePlainRecord(value, "visual routing analysis");
  const compositions: VisualComposition[] = [
    "interview-like",
    "conversation-like",
    "presentation-like",
    "b-roll",
    "action",
    "archive",
    "establishing",
    "mixed-or-uncertain",
  ];
  const composition = compositions.includes(
    record.composition as VisualComposition,
  )
    ? (record.composition as VisualComposition)
    : "mixed-or-uncertain";
  const evidenceFrameIds = uniqueAllowedIds(
    arrayStrings(record.evidenceFrameIds),
    allowedFrameIds,
  );
  if (evidenceFrameIds.length === 0) {
    throw new Error("The visual routing analysis did not cite its frame.");
  }
  return {
    composition,
    description: limitWordsAndSentences(
      String(record.description ?? ""),
      35,
      1,
    ),
    keywords: normalizeKeywords(arrayStrings(record.keywords), 10),
    evidenceFrameIds,
    confidence: boundedConfidence(record.confidence),
  };
}

export function calculateVisualStability(
  changeScores: number[],
): VisualStability {
  const scores = changeScores
    .filter(Number.isFinite)
    .map((score) => Math.min(1, Math.max(0, score)))
    .sort((left, right) => left - right);
  if (scores.length === 0) {
    return {
      significantChangeCount: 0,
      significantChangeRatio: 1,
      medianChangeScore: 1,
      maximumChangeScore: 1,
    };
  }
  const significantChangeCount = scores.filter((score) => score >= 0.085).length;
  const middle = Math.floor(scores.length / 2);
  const medianChangeScore =
    scores.length % 2 === 0
      ? (scores[middle - 1] + scores[middle]) / 2
      : scores[middle];
  return {
    significantChangeCount,
    significantChangeRatio: significantChangeCount / scores.length,
    medianChangeScore,
    maximumChangeScore: scores[scores.length - 1],
  };
}

export function chooseVisualRoute(
  transcript: TranscriptAnalysis,
  visual: VisualRoutingAnalysis,
  stability: VisualStability,
): "stableInterview" | "fullVisual" {
  const stable =
    transcript.speechFormat === "interview" &&
    transcript.confidence >= INTERVIEW_ROUTING.minimumTranscriptConfidence &&
    visual.composition === "interview-like" &&
    visual.confidence >= INTERVIEW_ROUTING.minimumVisualConfidence &&
    stability.significantChangeRatio <=
      INTERVIEW_ROUTING.maximumSignificantChangeRatio &&
    stability.medianChangeScore <= INTERVIEW_ROUTING.maximumMedianChangeScore &&
    stability.maximumChangeScore <= INTERVIEW_ROUTING.maximumChangeScore;
  return stable ? "stableInterview" : "fullVisual";
}

export function mergeClipAnalysis(
  transcript: TranscriptAnalysis | null,
  visualDescriptions: string[],
  visualKeywords: string[],
  visualEvidenceFrameIds: string[] = [],
): MergedClipAnalysis {
  const hasSubstantiveTranscript =
    transcript !== null &&
    transcript.speechFormat !== "no-substantive-speech" &&
    transcript.summary.length > 0;
  const visualDescription = visualDescriptions
    .map((value) => value.trim())
    .find(Boolean) ?? "";
  const description = limitWordsAndSentences(
    [hasSubstantiveTranscript ? transcript.summary : "", visualDescription]
      .filter(Boolean)
      .join(" "),
    70,
    2,
  );
  const transcriptTags = transcript
    ? normalizeKeywords([
        ...transcript.namedEntities,
        ...transcript.subjects,
        ...transcript.keywords,
      ], 20)
    : [];
  const generatedVisualTags = normalizeKeywords(visualKeywords, 20);
  const tags = normalizeKeywords([...transcriptTags, ...generatedVisualTags], 30);
  const keywordProvenance = tags.map((value) => {
    const key = value.toLocaleLowerCase();
    const sources: Array<"transcript" | "visual"> = [];
    if (transcriptTags.some((item) => item.toLocaleLowerCase() === key)) {
      sources.push("transcript");
    }
    if (generatedVisualTags.some((item) => item.toLocaleLowerCase() === key)) {
      sources.push("visual");
    }
    return {
      value,
      sources,
      evidenceUtteranceIds: sources.includes("transcript")
        ? transcript?.evidenceUtteranceIds ?? []
        : [],
      evidenceFrameIds: sources.includes("visual")
        ? [...new Set(visualEvidenceFrameIds)]
        : [],
    };
  });
  return {
    description,
    tags,
    generatedTranscriptTags: transcriptTags,
    generatedVisualTags,
    keywordProvenance,
  };
}

function uniqueAllowedIds(values: string[], allowed: string[]): string[] {
  const allowlist = new Set(allowed);
  return [...new Set(values.filter((value) => allowlist.has(value)))];
}

function boundedConfidence(value: unknown): number {
  return Math.min(1, Math.max(0, numeric(value)));
}

function limitWordsAndSentences(
  value: string,
  maximumWords: number,
  maximumSentences: number,
): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const sentences = compact.match(/[^.!?]+[.!?]?/g) ?? [compact];
  const selected = sentences.slice(0, maximumSentences).join(" ").trim();
  const words = selected.split(/\s+/);
  const result = words.slice(0, maximumWords).join(" ");
  return words.length > maximumWords
    ? `${result.replace(/[.,;:!?]+$/g, "")}…`
    : result;
}
