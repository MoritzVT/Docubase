import type {
  BatchJob,
  GoogleGenAI,
  InlinedRequest,
  InlinedResponse,
} from "@google/genai";
import type { AnalysisMode } from "../shared.js";
import { GEMINI_MODEL, readableProviderError } from "../shared.js";

const STANDARD_CONCURRENCY = 8;

export function analysisMode(value: unknown): AnalysisMode {
  return value === "fast" ? "fast" : "batch";
}

export function analysisOperation(mode: AnalysisMode): string {
  return mode === "fast"
    ? "gemini-standard-separated-clip-analysis"
    : "gemini-separated-clip-analysis";
}

export async function executeStandardRequests(
  ai: GoogleGenAI,
  jobReference: FirebaseFirestore.DocumentReference,
  requests: InlinedRequest[],
  label: string,
): Promise<string> {
  const runReference = jobReference.collection("standardRuns").doc();
  const runName = `standard:${runReference.id}`;
  await runReference.set({
    id: runReference.id,
    name: runName,
    label,
    state: "running",
    requestCount: requests.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const responses: InlinedResponse[] = new Array(requests.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(STANDARD_CONCURRENCY, requests.length) },
      async () => {
        while (cursor < requests.length) {
          const index = cursor;
          cursor += 1;
          const request = requests[index];
          try {
            const response = await ai.models.generateContent({
              model: GEMINI_MODEL,
              contents: request.contents ?? [],
              config: request.config,
            });
            responses[index] = {
              metadata: request.metadata,
              response,
            };
          } catch (error) {
            responses[index] = {
              metadata: request.metadata,
              error: { message: readableProviderError(error) },
            };
          }
        }
      },
    ),
  );

  const writer = jobReference.firestore.bulkWriter();
  responses.forEach((inline, index) => {
    const storedResponse = inline.response
      ? JSON.parse(JSON.stringify({
          candidates: inline.response.candidates ?? [],
          modelVersion: inline.response.modelVersion ?? null,
          responseId: inline.response.responseId ?? null,
          usageMetadata: inline.response.usageMetadata ?? {},
        }))
      : null;
    writer.set(runReference.collection("responses").doc(String(index)), {
      index,
      metadata: inline.metadata ?? {},
      response: storedResponse,
      error: inline.error ? { message: inline.error.message ?? "Request failed." } : null,
      createdAt: new Date().toISOString(),
    });
  });
  await writer.close();
  await runReference.set({
    state: "complete",
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return runName;
}

export async function standardResponsesAsBatch(
  jobReference: FirebaseFirestore.DocumentReference,
): Promise<BatchJob> {
  const runs = await jobReference
    .collection("standardRuns")
    .orderBy("createdAt")
    .get();
  const responseGroups = await Promise.all(
    runs.docs.map((run) => run.ref.collection("responses").orderBy("index").get()),
  );
  const inlinedResponses = responseGroups.flatMap((group) =>
    group.docs.map((snapshot) => {
      const data = snapshot.data();
      return {
        metadata: data.metadata ?? {},
        response: data.response ?? undefined,
        error: data.error ?? undefined,
      } as InlinedResponse;
    }),
  );
  return {
    name: `standard:${jobReference.id}`,
    state: "JOB_STATE_SUCCEEDED",
    dest: { inlinedResponses },
  } as BatchJob;
}
