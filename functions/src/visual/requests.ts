import {
  ThinkingLevel,
  Type,
  type InlinedRequest,
  type Schema,
} from "@google/genai";
import { HttpsError } from "firebase-functions/v2/https";
import {
  bucket,
  MAX_INLINE_BATCH_IMAGE_BYTES,
  MAX_VISUAL_FRAME_BYTES,
  MOMENTS_PER_BATCH,
  VISUAL_MOMENT_DURATION_MS,
  arrayStrings,
  numeric,
  requireId,
  type TranscriptEvidence,
  type TranscriptAnalysis,
  type VisualFrameRecord,
  type VisualMomentInput,
} from "../shared.js";

export function requireVisualFrame(
  frameId: string,
  value: FirebaseFirestore.DocumentData,
  projectId: string,
  clipId: string,
): VisualFrameRecord {
  const storagePath = String(value.storagePath ?? "");
  const expectedPath =
    `projects/${projectId}/clips/${clipId}/frames/${frameId}.jpg`;
  if (
    value.id !== frameId ||
    value.projectId !== projectId ||
    value.clipId !== clipId ||
    value.stage !== "ready" ||
    storagePath !== expectedPath
  ) {
    throw new HttpsError(
      "failed-precondition",
      `Visual frame ${frameId} is not a valid retained-frame record.`,
    );
  }
  const timestampMs = Math.round(numeric(value.timestampMs));
  const fileSizeBytes = Math.round(numeric(value.fileSizeBytes));
  if (
    timestampMs < 0 ||
    fileSizeBytes < 1 ||
    fileSizeBytes > 100 * 1_024
  ) {
    throw new HttpsError(
      "failed-precondition",
      `Visual frame ${frameId} has invalid metadata.`,
    );
  }
  return {
    id: frameId,
    projectId,
    clipId,
    momentId: requireId(value.momentId, "momentId"),
    timestampMs,
    storagePath,
    fileSizeBytes,
    changeScore: Math.min(1, Math.max(0, numeric(value.changeScore))),
  };
}

export function requireVisualFrameManifest(
  value: unknown,
  projectId: string,
  clipId: string,
): VisualFrameRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Visual frame metadata is invalid.");
  }
  const record = value as Record<string, unknown>;
  const id = requireId(record.id, "frameId");
  const timestampMs = Math.round(numeric(record.timestampMs));
  const fileSizeBytes = Math.round(numeric(record.fileSizeBytes));
  if (timestampMs < 0 || fileSizeBytes < 1 || fileSizeBytes > 100 * 1_024) {
    throw new HttpsError(
      "invalid-argument",
      `Visual frame ${id} has invalid metadata.`,
    );
  }
  return {
    id,
    projectId,
    clipId,
    momentId: requireId(record.momentId, "momentId"),
    timestampMs,
    storagePath: `projects/${projectId}/clips/${clipId}/frames/${id}.jpg`,
    fileSizeBytes,
    changeScore: Math.min(1, Math.max(0, numeric(record.changeScore))),
  };
}

export function transcriptEvidence(
  id: string,
  value: FirebaseFirestore.DocumentData,
): TranscriptEvidence | null {
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return null;
  const startMs = Math.max(0, Math.round(numeric(value.startMs)));
  const endMs = Math.max(startMs, Math.round(numeric(value.endMs)));
  const speaker =
    typeof value.speaker === "number" && Number.isInteger(value.speaker)
      ? value.speaker
      : null;
  return {
    id,
    startMs,
    endMs,
    speaker,
    text,
  };
}

export function groupVisualMoments(
  frames: VisualFrameRecord[],
): VisualMomentInput[] {
  const groups = new Map<string, VisualFrameRecord[]>();
  for (const frame of frames.sort(
    (left, right) => left.timestampMs - right.timestampMs,
  )) {
    const group = groups.get(frame.momentId) ?? [];
    group.push(frame);
    groups.set(frame.momentId, group);
  }
  return [...groups.entries()]
    .map(([id, momentFrames]) => {
      const index = Math.floor(
        momentFrames[0].timestampMs / VISUAL_MOMENT_DURATION_MS,
      );
      const startMs = index * VISUAL_MOMENT_DURATION_MS;
      const endMs = startMs + VISUAL_MOMENT_DURATION_MS;
      return {
        id,
        startMs,
        endMs,
        frames: momentFrames,
      };
    })
    .sort((left, right) => left.startMs - right.startMs);
}

export function partitionVisualMoments(
  moments: VisualMomentInput[],
): VisualMomentInput[][] {
  const groups: VisualMomentInput[][] = [];
  let current: VisualMomentInput[] = [];
  let currentBytes = 0;
  for (const moment of moments) {
    const momentBytes = moment.frames.reduce(
      (total, frame) => total + frame.fileSizeBytes,
      0,
    );
    if (
      current.length > 0 &&
      (current.length >= MOMENTS_PER_BATCH ||
        currentBytes + momentBytes > MAX_INLINE_BATCH_IMAGE_BYTES)
    ) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(moment);
    currentBytes += momentBytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function visualPromptContext(
  project: FirebaseFirestore.DocumentData,
  clip: FirebaseFirestore.DocumentData,
): string {
  const backgroundContext = String(project.contextText ?? "").slice(0, 12_000);
  return [
    `Project brief: ${String(project.brief ?? "").slice(0, 800) || "Not provided"}`,
    `Known names: ${arrayStrings(project.knownNames).slice(0, 30).join(", ").slice(0, 500) || "None"}`,
    `Terminology: ${arrayStrings(project.terminology).slice(0, 50).join(", ").slice(0, 800) || "None"}`,
    "Project background may clarify names, terminology, and subject matter, but it is not evidence that anything is said or visible in this clip.",
    `Project background: ${backgroundContext || "Not provided"}`,
    `Clip: ${String(clip.filename ?? "unknown").slice(0, 300)}`,
  ].join("\n");
}

export function transcriptAnalysisRequest(
  project: FirebaseFirestore.DocumentData,
  clip: FirebaseFirestore.DocumentData,
  transcript: TranscriptEvidence[],
  sectionIndex: number,
  sectionCount: number,
): InlinedRequest {
  const transcriptText = transcript.map((utterance) => {
    const speaker =
      utterance.speaker === null
        ? "Speaker"
        : `Speaker ${utterance.speaker + 1}`;
    return `[${utterance.id}] ${utterance.startMs}-${utterance.endMs} ms ${speaker}: ${utterance.text}`;
  }).join("\n");
  const sectionInstruction = sectionCount > 1
    ? `This is contiguous transcript section ${sectionIndex + 1} of ${sectionCount}. Analyze every supplied utterance; a later request will synthesize all sections.`
    : "This is the complete transcript for the clip.";
  const prompt = [
    "Analyze this documentary clip transcript for an editor. This request contains transcript evidence only; do not make visual claims.",
    sectionInstruction,
    "Use every supplied utterance as context, but summarize rather than quote. Determine, in order: the speech or footage format; the central subject; the main event, account, argument, or discussion; and important secondary subjects only when they materially distinguish the clip.",
    "Ignore greetings, filler, false starts, interviewer logistics, production chatter, and repeated takes when they are not the subject. Project background may clarify vocabulary and names, but claims about this clip must remain supported by its transcript evidence.",
    "Write one concise sentence, or two only when necessary, using no more than 55 words. Never use vague phrases such as 'spoken documentary material'. Never quote isolated transcript fragments as the summary.",
    "Generate 6-15 concise keywords an editor might type to retrieve this clip. Prioritize supported names, organizations, subjects, events, locations, and specific concepts. Prefer fewer accurate keywords over speculative, generic, or redundant keywords.",
    "Return exactly one JSON object using these camelCase keys: summary, speechFormat, subjects, keywords, namedEntities, evidenceUtteranceIds, confidence. Cite only supplied utterance IDs.",
    visualPromptContext(project, clip),
    `Clip duration: ${Math.max(0, Math.round(numeric(clip.durationMs)))} ms`,
    `Transcript:\n${transcriptText || "No non-empty transcript utterances."}`,
  ].join("\n\n");
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    metadata: {
      requestType: sectionCount > 1 ? "transcriptSection" : "transcript",
      sectionIndex: String(sectionIndex),
    },
    config: {
      temperature: 0.1,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: transcriptAnalysisResponseSchema(),
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
        includeThoughts: false,
      },
    },
  };
}

export function transcriptSynthesisRequest(
  project: FirebaseFirestore.DocumentData,
  clip: FirebaseFirestore.DocumentData,
  sections: TranscriptAnalysis[],
): InlinedRequest {
  const sectionText = sections.map((section, index) => [
    `Section ${index + 1}`,
    `Summary: ${section.summary}`,
    `Speech format: ${section.speechFormat}`,
    `Subjects: ${section.subjects.join(", ")}`,
    `Keywords: ${section.keywords.join(", ")}`,
    `Named entities: ${section.namedEntities.join(", ")}`,
    `Underlying utterance IDs: ${section.evidenceUtteranceIds.join(", ")}`,
  ].join("\n")).join("\n\n");
  const prompt = [
    "Synthesize a clip-wide transcript analysis from all contiguous section analyses below. Every section of the original transcript is represented.",
    "Follow the editorial hierarchy: speech or footage format, central subject, main event/account/argument/discussion, then important secondary subjects only when useful.",
    "Write one concise sentence, or two only when necessary, using no more than 55 words. Do not quote transcript fragments and do not make visual claims.",
    "Generate 6-15 accurate editor-searchable keywords. Prefer supported names and specific subjects over generic or redundant terms.",
    "Return exactly one JSON object using these camelCase keys: summary, speechFormat, subjects, keywords, namedEntities, evidenceUtteranceIds, confidence. Evidence IDs may only come from the underlying utterance ID lists below.",
    visualPromptContext(project, clip),
    sectionText,
  ].join("\n\n");
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    metadata: { requestType: "transcriptSynthesis" },
    config: {
      temperature: 0.1,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: transcriptAnalysisResponseSchema(),
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
        includeThoughts: false,
      },
    },
  };
}

export async function visualRoutingRequest(
  project: FirebaseFirestore.DocumentData,
  clip: FirebaseFirestore.DocumentData,
  frame: VisualFrameRecord,
): Promise<InlinedRequest> {
  const prompt = [
    "Analyze only what is visibly supported by this documentary frame. No transcript evidence is provided.",
    "Do not infer spoken topics, names, relationships, intent, location names, or off-screen events.",
    "Describe the visible composition in one concise sentence. Classify the composition and generate 4-10 concrete visual keywords covering useful people descriptors, actions, objects, setting, shot type, color, weather, or time of day when clearly visible. Prefer accuracy over quantity and avoid generic terms.",
    "Return exactly one JSON object using these camelCase keys: composition, description, keywords, evidenceFrameIds, confidence. Cite only the supplied frame ID.",
    visualPromptContext(project, clip),
    `Routing frame ID: ${frame.id}`,
  ].join("\n\n");
  return {
    contents: [{
      role: "user",
      parts: [{ text: prompt }, await visualImagePart(frame)],
    }],
    metadata: { requestType: "visualRouting", frameId: frame.id },
    config: {
      temperature: 0.1,
      maxOutputTokens: 350,
      responseMimeType: "application/json",
      responseSchema: visualRoutingResponseSchema(),
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
        includeThoughts: false,
      },
    },
  };
}

export async function visualMomentRequest(
  project: FirebaseFirestore.DocumentData,
  clip: FirebaseFirestore.DocumentData,
  moment: VisualMomentInput,
): Promise<InlinedRequest> {
  const imageParts = await Promise.all(
    moment.frames.map((frame) => visualImagePart(frame)),
  );
  const prompt = visualMomentPrompt(project, clip, moment);
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }, ...imageParts],
      },
    ],
    metadata: { requestType: "moment", momentId: moment.id },
    config: {
      temperature: 0.1,
      maxOutputTokens: 600,
      responseMimeType: "application/json",
      responseSchema: visualMomentResponseSchema(),
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
        includeThoughts: false,
      },
    },
  };
}

export function visualMomentPrompt(
  project: FirebaseFirestore.DocumentData,
  clip: FirebaseFirestore.DocumentData,
  moment: VisualMomentInput,
): string {
  return [
    "Analyze only the supplied chronological frames from this short documentary moment. No transcript evidence is provided, and the result must make only visible claims.",
    "Describe the dominant visible action and setting in concrete editor-friendly language. Mention changes across frames only when visibly supported.",
    "Do not infer names, dialogue, topics, locations, relationships, intent, chronology, or off-screen events.",
    "Generate 4-12 accurate visual keywords an editor might use to find this moment. Cover specific actions, objects, setting, shot or content type, people descriptors, weather, time of day, colors, and mood only when visibly supported. Prefer a smaller accurate set over speculative or redundant keywords.",
    "Return evidence IDs only from the lists supplied below.",
    "Return exactly one JSON object using these camelCase keys: description, tags, facets, evidenceFrameIds, confidence. The facets object must use: setting, weather, timeOfDay, dominantColors, mood, objects, actions, visiblePeople, contentType. Do not rename keys or add transcript, speech, clip, or time fields.",
    visualPromptContext(project, clip),
    `Moment: ${moment.startMs}-${moment.endMs} ms`,
    `Frame IDs in chronological order: ${moment.frames.map((frame) => frame.id).join(", ")}`,
  ].join("\n\n");
}

export async function visualImagePart(
  frame: VisualFrameRecord,
): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const [bytes] = await bucket.file(frame.storagePath).download();
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_VISUAL_FRAME_BYTES) {
    throw new Error(`Frame ${frame.id} is outside the 100 KB limit.`);
  }
  return {
    inlineData: {
      mimeType: "image/jpeg",
      data: bytes.toString("base64"),
    },
  };
}

export function transcriptAnalysisResponseSchema(): Schema {
  const stringArray: Schema = {
    type: Type.ARRAY,
    items: { type: Type.STRING },
  };
  return {
    type: Type.OBJECT,
    required: [
      "summary",
      "speechFormat",
      "subjects",
      "keywords",
      "namedEntities",
      "evidenceUtteranceIds",
      "confidence",
    ],
    properties: {
      summary: { type: Type.STRING },
      speechFormat: {
        type: Type.STRING,
        format: "enum",
        enum: [
          "interview",
          "conversation",
          "narration",
          "presentation",
          "production-chatter",
          "no-substantive-speech",
          "mixed",
          "unknown",
        ],
      },
      subjects: stringArray,
      keywords: stringArray,
      namedEntities: stringArray,
      evidenceUtteranceIds: stringArray,
      confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
    },
  };
}

export function visualRoutingResponseSchema(): Schema {
  const stringArray: Schema = {
    type: Type.ARRAY,
    items: { type: Type.STRING },
  };
  return {
    type: Type.OBJECT,
    required: [
      "composition",
      "description",
      "keywords",
      "evidenceFrameIds",
      "confidence",
    ],
    properties: {
      composition: {
        type: Type.STRING,
        format: "enum",
        enum: [
          "interview-like",
          "conversation-like",
          "presentation-like",
          "b-roll",
          "action",
          "archive",
          "establishing",
          "mixed-or-uncertain",
        ],
      },
      description: { type: Type.STRING },
      keywords: stringArray,
      evidenceFrameIds: stringArray,
      confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
    },
  };
}

export function visualMomentResponseSchema(): Schema {
  const stringArray: Schema = {
    type: Type.ARRAY,
    items: { type: Type.STRING },
  };
  return {
    type: Type.OBJECT,
    required: [
      "description",
      "tags",
      "facets",
      "evidenceFrameIds",
      "confidence",
    ],
    properties: {
      description: {
        type: Type.STRING,
        description: "Concrete, editor-friendly visual description.",
      },
      tags: stringArray,
      facets: {
        type: Type.OBJECT,
        required: [
          "setting",
          "weather",
          "timeOfDay",
          "dominantColors",
          "mood",
          "objects",
          "actions",
          "visiblePeople",
          "contentType",
        ],
        properties: {
          setting: stringArray,
          weather: stringArray,
          timeOfDay: stringArray,
          dominantColors: stringArray,
          mood: stringArray,
          objects: stringArray,
          actions: stringArray,
          visiblePeople: stringArray,
          contentType: {
            type: Type.STRING,
            format: "enum",
            enum: [
              "interview",
              "b-roll",
              "archive",
              "action",
              "establishing",
              "mixed",
              "unknown",
            ],
          },
        },
      },
      evidenceFrameIds: stringArray,
      confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
    },
  };
}
