export interface ClipSummaryEvidence {
  id: string;
  text: string;
}

export interface SanitizedClipSummary {
  description: string;
  tags: string[];
  evidenceFrameIds: string[];
  evidenceUtteranceIds: string[];
  confidence: number;
}

const MAX_DESCRIPTION_LENGTH = 3_000;
const MAX_TAGS = 40;

export function selectRepresentativeItems<T>(items: T[], limit: number): T[] {
  if (limit <= 0 || items.length === 0) return [];
  if (items.length <= limit) return [...items];
  if (limit === 1) return [items[Math.floor((items.length - 1) / 2)]];

  const selected: T[] = [];
  const seen = new Set<number>();
  for (let position = 0; position < limit; position += 1) {
    const index = Math.round(
      (position * (items.length - 1)) / (limit - 1),
    );
    if (!seen.has(index)) {
      selected.push(items[index]);
      seen.add(index);
    }
  }
  return selected;
}

export function selectTranscriptEvidence<T extends ClipSummaryEvidence>(
  utterances: T[],
  maxItems: number,
  maxCharacters: number,
): T[] {
  const candidates = selectRepresentativeItems(utterances, maxItems);
  const selected: T[] = [];
  let characters = 0;
  for (const utterance of candidates) {
    const length = utterance.text.length;
    if (selected.length > 0 && characters + length > maxCharacters) continue;
    selected.push(utterance);
    characters += length;
    if (characters >= maxCharacters) break;
  }
  return selected;
}

export function sanitizeClipSummary(
  value: unknown,
  allowedFrameIds: string[],
  allowedUtteranceIds: string[],
): SanitizedClipSummary {
  const record = plainRecord(value);
  if (!record) throw new Error("Gemini returned an invalid clip summary.");

  const descriptionValue =
    typeof record.description === "string"
      ? record.description
      : typeof record.summary === "string"
        ? record.summary
        : typeof record.clip_description === "string"
          ? record.clip_description
          : "";
  const description = descriptionValue.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  if (!description) throw new Error("The clip summary is empty.");

  const sharedEvidence = arrayStrings(record.evidence_ids);
  const evidenceFrameIds = uniqueIds(
    [
      ...arrayStrings(record.evidenceFrameIds),
      ...arrayStrings(record.evidence_frame_ids),
      ...arrayStrings(record.frame_ids),
      ...arrayStrings(record.frames),
      ...arrayStrings(record.visual_evidence),
      ...sharedEvidence,
    ].filter((id) => allowedFrameIds.includes(id)),
    allowedFrameIds.length,
  );
  if (evidenceFrameIds.length < 1) {
    throw new Error("The clip summary did not cite a retained frame.");
  }

  const evidenceUtteranceIds = uniqueIds(
    [
      ...arrayStrings(record.evidenceUtteranceIds),
      ...arrayStrings(record.evidence_utterance_ids),
      ...arrayStrings(record.transcript_ids),
      ...arrayStrings(record.transcript),
      ...arrayStrings(record.transcript_evidence),
      ...sharedEvidence,
    ].filter((id) => allowedUtteranceIds.includes(id)),
    allowedUtteranceIds.length,
  );
  if (allowedUtteranceIds.length > 0 && evidenceUtteranceIds.length < 1) {
    throw new Error("The clip summary did not cite supplied transcript evidence.");
  }

  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : 0.5;
  return {
    description,
    tags: uniqueStrings(arrayStrings(record.tags), MAX_TAGS),
    evidenceFrameIds,
    evidenceUtteranceIds,
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}

export function extractiveClipDescription(
  momentDescriptions: string[],
  utterances: ClipSummaryEvidence[],
): string {
  const visualSummary = conciseVisualSummary(momentDescriptions);
  const spokenTopic = substantiveSpokenTopic(utterances);

  if (spokenTopic && visualSummary) {
    const combined =
      `The clip centers on the speaker’s account that ${lowercaseFirst(
        spokenTopic,
      )}. Visually, it shows ${visualSummary}.`
    if (wordCount(combined) <= 70) return combined;
  }
  if (spokenTopic) {
    return (
      `The clip centers on the speaker’s account that ${lowercaseFirst(
        spokenTopic,
      )}.`
    ).slice(0, MAX_DESCRIPTION_LENGTH);
  }
  if (utterances.length > 0 && visualSummary) {
    return (
      `Interview or conversational footage showing ${visualSummary}.`
    ).slice(0, MAX_DESCRIPTION_LENGTH);
  }
  if (utterances.length > 0) {
    return "Interview or conversational footage with brief spoken exchanges.";
  }
  if (visualSummary) {
    return `Visual footage showing ${visualSummary}.`.slice(
      0,
      MAX_DESCRIPTION_LENGTH,
    );
  }
  return "No clear clip summary could be generated from the available evidence.";
}

function substantiveSpokenTopic(
  utterances: ClipSummaryEvidence[],
): string | null {
  const candidates = utterances
    .flatMap((utterance) => splitSentences(utterance.text))
    .map(cleanSpokenSentence)
    .filter((value): value is string => value !== null)
    .map((text) => ({ text, score: spokenSentenceScore(text) }))
    .filter((value) => value.score >= 7)
    .sort(
      (left, right) =>
        right.score - left.score || left.text.length - right.text.length,
    );

  const distinct: string[] = [];
  for (const candidate of candidates) {
    if (
      distinct.some(
        (existing) => wordSimilarity(existing, candidate.text) >= 0.72,
      )
    ) {
      continue;
    }
    distinct.push(candidate.text);
    if (distinct.length === 1) break;
  }
  return distinct[0] ?? null;
}

function cleanSpokenSentence(value: string): string | null {
  let text = value.replace(/\s+/g, " ").trim();
  text = text
    .replace(
      /^(?:(?:yeah|yes|so|okay|ok|cool|great|mhmm|mm-hmm|um|uh)[,.]?\s+)+/i,
      "",
    )
    .replace(/^(?:let me say (?:that|it) again)[,.]?\s*/i, "")
    .trim();
  const words = text.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
  if (words.length < 8 || words.length > 55) return null;
  if (
    /^(?:who|what|when|where|why|how|did|do|does|can|could|would|will|is|are)\b/i.test(
      text,
    ) ||
    text.includes("?")
  ) {
    return null;
  }
  if (
    /\b(?:one other question|say (?:that|it) again|take it again|rolling|sound speed|camera speed)\b/i.test(
      text,
    )
  ) {
    return null;
  }
  if (/\b(?:and|or|but|because|it's|is|to|the|a|an)$/i.test(text)) {
    return null;
  }
  return text.replace(/[.!?,;:]+$/g, "").trim() || null;
}

function spokenSentenceScore(text: string): number {
  const words = (text.toLocaleLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []);
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "but",
    "by",
    "for",
    "from",
    "he",
    "her",
    "him",
    "his",
    "i",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "she",
    "that",
    "the",
    "their",
    "they",
    "this",
    "to",
    "was",
    "we",
    "were",
    "with",
    "you",
  ]);
  const contentWords = new Set(
    words.filter((word) => word.length > 2 && !stopWords.has(word)),
  );
  const lengthBonus = words.length >= 12 && words.length <= 35 ? 3 : 1;
  const detailBonus = words.some((word) => /\d/.test(word)) ? 2 : 0;
  return contentWords.size + lengthBonus + detailBonus;
}

function conciseVisualSummary(descriptions: string[]): string {
  const candidates = descriptions
    .flatMap(splitSentences)
    .map((value) =>
      value
        .replace(
          /^(?:the|this|a)\s+(?:image|frame|still|screenshot|scene)\s+(?:shows|depicts)\s+/i,
          "",
        )
        .replace(/\s+/g, " ")
        .replace(/[.!]+$/g, "")
        .trim(),
    )
    .filter((value) => value.length >= 12 && value.length <= 280);
  const distinct: string[] = [];
  for (const candidate of candidates) {
    if (
      distinct.some(
        (existing) => wordSimilarity(existing, candidate) >= 0.72,
      )
    ) {
      continue;
    }
    distinct.push(candidate);
    break;
  }
  return lowercaseFirst(trimAtWordBoundary(distinct.join("; "), 180));
}

function splitSentences(value: string): string[] {
  return value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordSimilarity(left: string, right: string): number {
  const words = (value: string) =>
    new Set(
      (value.toLocaleLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []).filter(
        (word) => word.length > 2,
      ),
    );
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  const intersection = [...leftWords].filter((word) =>
    rightWords.has(word),
  ).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  return intersection / union;
}

function lowercaseFirst(value: string): string {
  if (!value) return value;
  return `${value[0].toLocaleLowerCase()}${value.slice(1)}`;
}

function trimAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const shortened = value.slice(0, maxLength + 1);
  const boundary = shortened.lastIndexOf(" ");
  return shortened.slice(0, boundary > 0 ? boundary : maxLength).trim();
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function uniqueStrings(values: string[], limit: number): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, Math.max(0, limit));
}

function uniqueIds(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(0, Math.max(0, limit));
}
