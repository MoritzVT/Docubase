import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  SEARCH_EMBEDDING_DIMENSIONS,
  SEARCH_EMBEDDING_MODEL,
  SEARCH_INDEX_VERSION,
  buildTranscriptPassages,
  estimateEmbeddingTokens,
  filenameAliases,
  normalizeFilename,
  prepareSearchDocument,
  prepareSearchQuery,
  scopeKind,
  searchDocumentId,
  type SearchDocumentRecord,
  type SearchScope,
  type SearchUtterance,
} from "./search-core.js";
import {
  REGION,
  arrayStrings,
  database,
  geminiApiKey,
  numeric,
  readableProviderError,
  requireGeminiClient,
  requireId,
  requireMember,
  requireProjectOwner,
  requireRecord,
  requireUserId,
  uniqueStrings,
} from "./shared.js";

const RECORDS_PER_BATCH = 500;
const MAX_RESULTS = 30;
const VECTOR_CANDIDATE_LIMIT = 80;
const BATCH_EMBEDDING_USD_PER_MILLION_TOKENS = 0.10;
const STANDARD_EMBEDDING_USD_PER_MILLION_TOKENS = 0.20;
const TERMINAL_BATCH_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
]);

interface SearchIndexState {
  jobId: string | null;
  mode: "batch" | "fast";
  state: "not_started" | "pending" | "running" | "complete" | "failed";
  totalRecords: number;
  embeddedRecords: number;
  completedBatches: number;
  totalBatches: number;
  estimatedCostUsd: number;
  recordedCostUsd: number;
  error: string | null;
  updatedAt: string | null;
}

export const getSearchIndexStatus = onCall(
  { region: REGION, memory: "256MiB", maxInstances: 10, timeoutSeconds: 30 },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const projectReference = database.doc(`projects/${projectId}`);
    const projectSnapshot = await projectReference.get();
    requireMember(projectSnapshot.data(), userId);
    return {
      ...searchIndexState(projectSnapshot.data()?.searchIndex),
      recordedCostUsd: await recordedSearchIndexCost(projectReference),
    };
  },
);

export const estimateSearchIndex = onCall(
  { region: REGION, memory: "1GiB", maxInstances: 4, timeoutSeconds: 540 },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const projectSnapshot = await database.doc(`projects/${projectId}`).get();
    requireMember(projectSnapshot.data(), userId);
    const records = await collectSearchRecords(projectId);
    const estimatedTokens = estimateEmbeddingTokens(records);
    return {
      totalRecords: records.length,
      estimatedTokens,
      batchCostUsd: embeddingCost(estimatedTokens, "batch"),
      fastCostUsd: embeddingCost(estimatedTokens, "fast"),
    };
  },
);

export const cancelSearchIndex = onCall(
  {
    region: REGION,
    memory: "512MiB",
    maxInstances: 4,
    timeoutSeconds: 120,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const projectReference = database.doc(`projects/${projectId}`);
    const projectSnapshot = await projectReference.get();
    requireProjectOwner(projectSnapshot.data(), userId);
    const current = searchIndexState(projectSnapshot.data()?.searchIndex);
    const reset = emptySearchIndexState();

    if (current.jobId) {
      const jobReference = projectReference.collection("searchIndexJobs").doc(current.jobId);
      await jobReference.set({
        cancelRequested: true,
        state: "failed",
        error: "Canceled by user.",
        updatedAt: reset.updatedAt,
      }, { merge: true });
      const batches = await jobReference.collection("batches").get();
      const names = batches.docs
        .map((snapshot) => String(snapshot.data().batchName ?? ""))
        .filter(Boolean);
      if (names.length > 0) {
        const ai = requireGeminiClient();
        await Promise.allSettled(names.map((name) => ai.batches.cancel({ name })));
      }
      await deleteSearchDocumentsForJob(
        projectReference.collection("searchDocuments"),
        current.jobId,
      );
    }

    await projectReference.set({ searchIndex: reset }, { merge: true });
    return reset;
  },
);

export const startSearchIndex = onCall(
  {
    region: REGION,
    memory: "1GiB",
    maxInstances: 2,
    timeoutSeconds: 540,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const projectReference = database.doc(`projects/${projectId}`);
    const projectSnapshot = await projectReference.get();
    requireProjectOwner(projectSnapshot.data(), userId);
    const mode = data.mode === "fast" ? "fast" : "batch";

    const current = searchIndexState(projectSnapshot.data()?.searchIndex);
    if (current.jobId && ["pending", "running"].includes(current.state)) {
      return current;
    }

    const jobReference = projectReference.collection("searchIndexJobs").doc();
    const jobId = jobReference.id;
    const timestamp = new Date().toISOString();
    const records = await collectSearchRecords(projectId);
    const estimatedTokens = estimateEmbeddingTokens(records);
    const estimatedCostUsd = roundUsd(
      estimatedTokens * (mode === "fast"
        ? STANDARD_EMBEDDING_USD_PER_MILLION_TOKENS
        : BATCH_EMBEDDING_USD_PER_MILLION_TOKENS) / 1_000_000,
    );
    const groups = partition(records, RECORDS_PER_BATCH);
    const initial: SearchIndexState = {
      jobId,
      mode,
      state: records.length === 0 ? "complete" : "pending",
      totalRecords: records.length,
      embeddedRecords: 0,
      completedBatches: 0,
      totalBatches: groups.length,
      estimatedCostUsd,
      recordedCostUsd: 0,
      error: null,
      updatedAt: timestamp,
    };
    await jobReference.set({
      ...initial,
      id: jobId,
      projectId,
      model: SEARCH_EMBEDDING_MODEL,
      dimensions: SEARCH_EMBEDDING_DIMENSIONS,
      indexVersion: SEARCH_INDEX_VERSION,
      mode,
      estimatedTokens,
      createdAt: timestamp,
    });
    await projectReference.set({ searchIndex: initial }, { merge: true });
    if (records.length === 0) return initial;

    const writer = database.bulkWriter();
    for (const record of records) {
      writer.set(jobReference.collection("records").doc(record.id), record);
    }
    await writer.close();

    const submittedBatchNames: string[] = [];
    const ai = requireGeminiClient();
    try {
      if (mode === "fast") {
        const searchCollection = projectReference.collection("searchDocuments");
        const embeddingWriter = database.bulkWriter();
        let embeddedRecords = 0;
        for (const [groupIndex, group] of groups.entries()) {
          if (await searchIndexCancelRequested(jobReference)) {
            await embeddingWriter.close();
            await deleteSearchDocumentsForJob(searchCollection, jobId);
            return searchIndexState((await projectReference.get()).data()?.searchIndex);
          }
          const response = await ai.models.embedContent({
            model: SEARCH_EMBEDDING_MODEL,
            contents: group.map((record) => ({
              parts: [{ text: record.embeddingText }],
              role: "user",
            })),
            config: { outputDimensionality: SEARCH_EMBEDDING_DIMENSIONS },
          });
          const embeddings = response.embeddings ?? [];
          if (await searchIndexCancelRequested(jobReference)) {
            await embeddingWriter.close();
            await deleteSearchDocumentsForJob(searchCollection, jobId);
            return searchIndexState((await projectReference.get()).data()?.searchIndex);
          }
          if (embeddings.length !== group.length) {
            throw new Error(
              `Gemini returned ${embeddings.length} embeddings for ${group.length} search records.`,
            );
          }
          for (let index = 0; index < group.length; index += 1) {
            const values = embeddings[index].values;
            if (values?.length !== SEARCH_EMBEDDING_DIMENSIONS) {
              throw new Error(`Gemini returned an invalid embedding for ${group[index].id}.`);
            }
            const { embeddingText: _embeddingText, ...stored } = group[index];
            embeddingWriter.set(searchCollection.doc(group[index].id), {
              ...stored,
              embedding: FieldValue.vector(values),
              embeddingModel: SEARCH_EMBEDDING_MODEL,
              embeddingDimensions: SEARCH_EMBEDDING_DIMENSIONS,
              indexVersion: SEARCH_INDEX_VERSION,
              indexJobId: jobId,
              updatedAt: new Date().toISOString(),
            });
            embeddedRecords += 1;
          }
          const running: SearchIndexState = {
            ...initial,
            state: "running",
            embeddedRecords,
            completedBatches: groupIndex + 1,
            updatedAt: new Date().toISOString(),
          };
          await Promise.all([
            jobReference.set(running, { merge: true }),
            projectReference.set({ searchIndex: running }, { merge: true }),
          ]);
        }
        await embeddingWriter.close();
        if (await searchIndexCancelRequested(jobReference)) {
          await deleteSearchDocumentsForJob(searchCollection, jobId);
          return searchIndexState((await projectReference.get()).data()?.searchIndex);
        }
        await deleteStaleSearchDocuments(searchCollection, jobId);
        const complete: SearchIndexState = {
          ...initial,
          state: "complete",
          embeddedRecords,
          completedBatches: groups.length,
          error: null,
          updatedAt: new Date().toISOString(),
        };
        await Promise.all([
          jobReference.set(complete, { merge: true }),
          projectReference.set({ searchIndex: complete }, { merge: true }),
        ]);
        return complete;
      }
      for (const [index, group] of groups.entries()) {
        const batch = await ai.batches.createEmbeddings({
          model: SEARCH_EMBEDDING_MODEL,
          src: {
            // Separate Content objects produce one embedding per record while
            // sharing the same output-size configuration.
            inlinedRequests: {
              contents: group.map((record) => ({
                parts: [{ text: record.embeddingText }],
                role: "user",
              })),
              config: { outputDimensionality: SEARCH_EMBEDDING_DIMENSIONS },
            },
          },
          config: { displayName: `Docubase search ${jobId} ${index + 1}` },
        });
        if (!batch.name) throw new Error("Gemini returned a batch without a name.");
        submittedBatchNames.push(batch.name);
        await jobReference.collection("batches").doc(index.toString().padStart(6, "0")).set({
          index,
          batchName: batch.name,
          recordIds: group.map((record) => record.id),
          state: String(batch.state ?? "JOB_STATE_PENDING"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      return initial;
    } catch (error) {
      if (submittedBatchNames.length > 0) {
        await Promise.allSettled(
          submittedBatchNames.map((name) => ai.batches.cancel({ name })),
        );
      }
      const message = `Search indexing could not start: ${readableProviderError(error)}`;
      const failed: SearchIndexState = { ...initial, state: "failed", error: message };
      await Promise.all([
        jobReference.set(failed, { merge: true }),
        projectReference.set({ searchIndex: failed }, { merge: true }),
      ]);
      throw new HttpsError("unavailable", message);
    }
  },
);

export const refreshSearchIndex = onCall(
  {
    region: REGION,
    memory: "1GiB",
    maxInstances: 4,
    timeoutSeconds: 540,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const projectReference = database.doc(`projects/${projectId}`);
    const projectSnapshot = await projectReference.get();
    requireMember(projectSnapshot.data(), userId);
    const current = searchIndexState(projectSnapshot.data()?.searchIndex);
    if (!current.jobId || ["complete", "failed", "not_started"].includes(current.state)) {
      return current;
    }

    const jobReference = projectReference.collection("searchIndexJobs").doc(current.jobId);
    if (await searchIndexCancelRequested(jobReference)) {
      return searchIndexState((await projectReference.get()).data()?.searchIndex);
    }
    if (current.mode === "fast") return current;
    const batchesSnapshot = await jobReference.collection("batches").orderBy("index").get();
    const ai = requireGeminiClient();
    const batches = await Promise.all(
      batchesSnapshot.docs.map(async (snapshot) => {
        const name = String(snapshot.data().batchName ?? "");
        if (!name) throw new Error("A search batch is missing its provider name.");
        const batch = await ai.batches.get({ name });
        await snapshot.ref.set({
          state: String(batch.state ?? "JOB_STATE_UNSPECIFIED"),
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        return { snapshot, batch };
      }),
    );
    const completedBatches = batches.filter(({ batch }) =>
      TERMINAL_BATCH_STATES.has(String(batch.state))).length;
    if (await searchIndexCancelRequested(jobReference)) {
      return searchIndexState((await projectReference.get()).data()?.searchIndex);
    }
    if (completedBatches < batches.length) {
      const running: SearchIndexState = {
        ...current,
        state: "running",
        completedBatches,
        updatedAt: new Date().toISOString(),
      };
      await Promise.all([
        jobReference.set(running, { merge: true }),
        projectReference.set({ searchIndex: running }, { merge: true }),
      ]);
      return running;
    }

    const failedBatch = batches.find(
      ({ batch }) => String(batch.state) !== "JOB_STATE_SUCCEEDED",
    );
    if (failedBatch) {
      const message = failedBatch.batch.error?.message ??
        `Gemini embedding batch ended in ${String(failedBatch.batch.state)}.`;
      const failed: SearchIndexState = {
        ...current,
        state: "failed",
        completedBatches,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      await Promise.all([
        jobReference.set(failed, { merge: true }),
        projectReference.set({ searchIndex: failed }, { merge: true }),
      ]);
      return failed;
    }

    const searchCollection = projectReference.collection("searchDocuments");
    const writer = database.bulkWriter();
    let embeddedRecords = 0;
    for (const { snapshot, batch } of batches) {
      const recordIds = arrayStrings(snapshot.data().recordIds);
      const responses = batch.dest?.inlinedEmbedContentResponses ?? [];
      if (recordIds.length !== responses.length) {
        throw new HttpsError(
          "data-loss",
          `Gemini returned ${responses.length} embeddings for ${recordIds.length} search records.`,
        );
      }
      const recordSnapshots = await database.getAll(
        ...recordIds.map((recordId) => jobReference.collection("records").doc(recordId)),
      );
      for (let index = 0; index < recordIds.length; index += 1) {
        const response = responses[index];
        const values = response.response?.embedding?.values;
        const record = recordSnapshots[index].data();
        if (response.error || !record || values?.length !== SEARCH_EMBEDDING_DIMENSIONS) {
          throw new HttpsError(
            "data-loss",
            response.error?.message ?? `Gemini returned an invalid embedding for ${recordIds[index]}.`,
          );
        }
        const { embeddingText: _embeddingText, ...stored } = record;
        writer.set(searchCollection.doc(recordIds[index]), {
          ...stored,
          embedding: FieldValue.vector(values),
          embeddingModel: SEARCH_EMBEDDING_MODEL,
          embeddingDimensions: SEARCH_EMBEDDING_DIMENSIONS,
          indexVersion: SEARCH_INDEX_VERSION,
          indexJobId: current.jobId,
          updatedAt: new Date().toISOString(),
        });
        embeddedRecords += 1;
      }
    }
    await writer.close();

    await deleteStaleSearchDocuments(searchCollection, current.jobId);

    const complete: SearchIndexState = {
      ...current,
      state: "complete",
      embeddedRecords,
      completedBatches: batches.length,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([
      jobReference.set(complete, { merge: true }),
      projectReference.set({ searchIndex: complete }, { merge: true }),
    ]);
    return complete;
  },
);

export const searchProject = onCall(
  {
    region: REGION,
    memory: "512MiB",
    maxInstances: 20,
    timeoutSeconds: 60,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const query = String(data.query ?? "").trim().slice(0, 1_000);
    const scope = requireScope(data.scope);
    const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(numeric(data.limit) || 20)));
    if (query.length < 2) {
      throw new HttpsError("invalid-argument", "Enter at least two search characters.");
    }
    const projectReference = database.doc(`projects/${projectId}`);
    const projectSnapshot = await projectReference.get();
    requireMember(projectSnapshot.data(), userId);
    const status = searchIndexState(projectSnapshot.data()?.searchIndex);
    if (status.state !== "complete") {
      throw new HttpsError("failed-precondition", "Build the project search index first.");
    }

    const searchCollection = projectReference.collection("searchDocuments");
    const exactPromise = scope === "all"
      ? searchCollection.where("filenameAliases", "array-contains", normalizeFilename(query)).get()
      : Promise.resolve(null);
    const ai = requireGeminiClient();
    const embedded = await ai.models.embedContent({
      model: SEARCH_EMBEDDING_MODEL,
      contents: prepareSearchQuery(query),
      config: { outputDimensionality: SEARCH_EMBEDDING_DIMENSIONS },
    });
    const queryVector = embedded.embeddings?.[0]?.values;
    if (queryVector?.length !== SEARCH_EMBEDDING_DIMENSIONS) {
      throw new HttpsError("unavailable", "Gemini returned an invalid search embedding.");
    }
    const kind = scopeKind(scope);
    const baseQuery = kind ? searchCollection.where("kind", "==", kind) : searchCollection;
    const vectorSnapshot = await baseQuery.findNearest({
      vectorField: "embedding",
      queryVector,
      limit: Math.max(limit * 3, VECTOR_CANDIDATE_LIMIT),
      distanceMeasure: "COSINE",
      distanceResultField: "vectorDistance",
    }).get();
    const exactSnapshot = await exactPromise;
    const exact = (exactSnapshot?.docs ?? [])
      .filter((document) => document.data().kind === "clip")
      .map((document) => searchResult(document.id, document.data(), true));
    const seen = new Set(exact.map((result) => result.id));
    const ranked = vectorSnapshot.docs.flatMap((document) => {
      if (seen.has(document.id)) return [];
      const result = searchResult(document.id, document.data(), false);
      seen.add(document.id);
      return [result];
    });
    await projectReference.collection("searchUsage").add({
      operation: "semantic_search_query",
      estimatedCostUsd: embeddingCost(
        Math.ceil(prepareSearchQuery(query).length / 4),
        "fast",
      ),
      createdAt: new Date().toISOString(),
    });
    return {
      query,
      scope,
      results: [...exact, ...ranked].slice(0, limit),
      indexUpdatedAt: status.updatedAt,
    };
  },
);

async function collectSearchRecords(projectId: string): Promise<SearchDocumentRecord[]> {
  const projectReference = database.doc(`projects/${projectId}`);
  const clipsSnapshot = await projectReference.collection("clips").get();
  const momentsByClip = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  const utterancesByClip = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  const framesByClip = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const clipGroup of partition(clipsSnapshot.docs, 25)) {
    const loaded = await Promise.all(clipGroup.map(async (clipSnapshot) => {
      const [moments, utterances, frames] = await Promise.all([
        clipSnapshot.ref.collection("visualMoments").get(),
        clipSnapshot.ref.collection("transcriptUtterances").get(),
        clipSnapshot.ref.collection("visualFrames").get(),
      ]);
      return { clipId: clipSnapshot.id, moments, utterances, frames };
    }));
    for (const item of loaded) {
      momentsByClip.set(item.clipId, item.moments.docs);
      utterancesByClip.set(item.clipId, item.utterances.docs);
      framesByClip.set(item.clipId, item.frames.docs);
    }
  }
  const records: SearchDocumentRecord[] = [];

  for (const clipSnapshot of clipsSnapshot.docs) {
    const clip = clipSnapshot.data();
    const clipId = clipSnapshot.id;
    const filename = String(clip.filename ?? clipId);
    const aliases = filenameAliases(filename);
    const frames = (framesByClip.get(clipId) ?? [])
      .sort((left, right) => numeric(left.data().timestampMs) - numeric(right.data().timestampMs));
    const firstFrame = frames[0]?.data();
    const description = String(clip.description ?? "").trim();
    const tags = uniqueStrings(arrayStrings(clip.tags), 40);
    const clipText = [description, tags.length ? `Keywords: ${tags.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n");
    records.push({
      id: searchDocumentId("clip", clipId, "summary"),
      projectId,
      clipId,
      kind: "clip",
      filename,
      filenameAliases: aliases,
      description,
      tags,
      startMs: 0,
      endMs: numeric(clip.durationMs),
      frameIds: firstFrame ? [String(firstFrame.id ?? frames[0].id)] : [],
      utteranceIds: [],
      thumbnailStoragePath: firstFrame ? String(firstFrame.storagePath ?? "") || null : null,
      embeddingText: prepareSearchDocument(filename, clipText || filename),
    });

    for (const momentSnapshot of momentsByClip.get(clipId) ?? []) {
      const moment = momentSnapshot.data();
      if (moment.stage !== "complete") continue;
      const momentDescription = String(moment.description ?? "").trim();
      const momentTags = uniqueStrings(arrayStrings(moment.tags), 40);
      if (!momentDescription && momentTags.length === 0) continue;
      const frameIds = uniqueStrings([
        ...arrayStrings(moment.evidenceFrameIds),
        ...arrayStrings(moment.frameIds),
      ], 20);
      const thumbnail = frames.find((frame) => frameIds.includes(frame.id))?.data() ??
        frames.find((frame) => frame.data().momentId === momentSnapshot.id)?.data();
      records.push({
        id: searchDocumentId("visual", clipId, momentSnapshot.id),
        projectId,
        clipId,
        kind: "visual",
        filename,
        filenameAliases: [],
        description: momentDescription,
        tags: momentTags,
        startMs: numeric(moment.startMs),
        endMs: numeric(moment.endMs),
        frameIds,
        utteranceIds: [],
        thumbnailStoragePath: thumbnail ? String(thumbnail.storagePath ?? "") || null : null,
        embeddingText: prepareSearchDocument(
          filename,
          [momentDescription, momentTags.length ? `Visual keywords: ${momentTags.join(", ")}` : ""]
            .filter(Boolean)
            .join("\n"),
        ),
      });
    }

    const utterances: SearchUtterance[] = (utterancesByClip.get(clipId) ?? []).map((snapshot) => ({
      id: snapshot.id,
      startMs: numeric(snapshot.data().startMs),
      endMs: numeric(snapshot.data().endMs),
      text: String(snapshot.data().text ?? ""),
    }));
    for (const passage of buildTranscriptPassages(utterances, numeric(clip.durationMs))) {
      records.push({
        id: searchDocumentId("spoken", clipId, passage.id),
        projectId,
        clipId,
        kind: "spoken",
        filename,
        filenameAliases: [],
        description: passage.text,
        tags: [],
        startMs: passage.startMs,
        endMs: passage.endMs,
        frameIds: [],
        utteranceIds: passage.utteranceIds,
        thumbnailStoragePath: nearestFramePath(frames, passage.startMs),
        embeddingText: prepareSearchDocument(filename, passage.text),
      });
    }
  }
  return records;
}

function nearestFramePath(
  frames: FirebaseFirestore.QueryDocumentSnapshot[],
  timestampMs: number,
): string | null {
  let nearest: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const candidateDistance = Math.abs(numeric(frame.data().timestampMs) - timestampMs);
    if (candidateDistance < distance) {
      nearest = frame;
      distance = candidateDistance;
    }
  }
  return nearest ? String(nearest.data().storagePath ?? "") || null : null;
}

function searchIndexState(value: unknown): SearchIndexState {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawState = String(source.state ?? "not_started");
  const state: SearchIndexState["state"] =
    ["pending", "running", "complete", "failed"].includes(rawState)
      ? rawState as SearchIndexState["state"]
      : "not_started";
  return {
    jobId: typeof source.jobId === "string" ? source.jobId : null,
    mode: source.mode === "fast" ? "fast" : "batch",
    state,
    totalRecords: numeric(source.totalRecords),
    embeddedRecords: numeric(source.embeddedRecords),
    completedBatches: numeric(source.completedBatches),
    totalBatches: numeric(source.totalBatches),
    estimatedCostUsd: numeric(source.estimatedCostUsd),
    recordedCostUsd: numeric(source.recordedCostUsd),
    error: typeof source.error === "string" ? source.error : null,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

function searchResult(
  id: string,
  value: FirebaseFirestore.DocumentData,
  exactFilename: boolean,
) {
  const distance = numeric(value.vectorDistance);
  return {
    id,
    kind: value.kind,
    clipId: String(value.clipId ?? ""),
    filename: String(value.filename ?? ""),
    description: String(value.description ?? ""),
    tags: arrayStrings(value.tags),
    startMs: numeric(value.startMs),
    endMs: numeric(value.endMs),
    frameIds: arrayStrings(value.frameIds),
    utteranceIds: arrayStrings(value.utteranceIds),
    thumbnailStoragePath:
      typeof value.thumbnailStoragePath === "string" ? value.thumbnailStoragePath : null,
    score: exactFilename ? 1 : Math.max(0, Math.min(1, 1 - distance)),
    exactFilename,
  };
}

function requireScope(value: unknown): SearchScope {
  if (value === "visual" || value === "spoken" || value === "all") return value;
  return "all";
}

function partition<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

async function deleteStaleSearchDocuments(
  collection: FirebaseFirestore.CollectionReference,
  jobId: string,
): Promise<void> {
  const oldDocuments = await collection.get();
  const writer = database.bulkWriter();
  for (const document of oldDocuments.docs) {
    if (document.data().indexJobId !== jobId) writer.delete(document.ref);
  }
  await writer.close();
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function embeddingCost(tokens: number, mode: "batch" | "fast"): number {
  return roundUsd(
    Math.max(0, tokens) * (mode === "fast"
      ? STANDARD_EMBEDDING_USD_PER_MILLION_TOKENS
      : BATCH_EMBEDDING_USD_PER_MILLION_TOKENS) / 1_000_000,
  );
}

async function recordedSearchIndexCost(
  projectReference: FirebaseFirestore.DocumentReference,
): Promise<number> {
  const [jobs, searches] = await Promise.all([
    projectReference.collection("searchIndexJobs").get(),
    projectReference.collection("searchUsage").get(),
  ]);
  const indexCost = jobs.docs.reduce((total, snapshot) => {
    const job = snapshot.data();
    const estimate = numeric(job.estimatedCostUsd);
    if (job.state === "complete") return total + estimate;
    if (job.mode === "fast") {
      const records = numeric(job.totalRecords);
      return total + (records > 0
        ? estimate * Math.min(1, numeric(job.embeddedRecords) / records)
        : 0);
    }
    const batches = numeric(job.totalBatches);
    return total + (batches > 0
      ? estimate * Math.min(1, numeric(job.completedBatches) / batches)
      : 0);
  }, 0);
  const queryCost = searches.docs.reduce(
    (total, snapshot) => total + numeric(snapshot.data().estimatedCostUsd),
    0,
  );
  return roundUsd(indexCost + queryCost);
}

function emptySearchIndexState(): SearchIndexState {
  return {
    jobId: null,
    mode: "batch",
    state: "not_started",
    totalRecords: 0,
    embeddedRecords: 0,
    completedBatches: 0,
    totalBatches: 0,
    estimatedCostUsd: 0,
    recordedCostUsd: 0,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

async function searchIndexCancelRequested(
  jobReference: FirebaseFirestore.DocumentReference,
): Promise<boolean> {
  return (await jobReference.get()).data()?.cancelRequested === true;
}

async function deleteSearchDocumentsForJob(
  collection: FirebaseFirestore.CollectionReference,
  jobId: string,
): Promise<void> {
  const documents = await collection.get();
  const writer = database.bulkWriter();
  for (const document of documents.docs) {
    if (document.data().indexJobId === jobId) writer.delete(document.ref);
  }
  await writer.close();
}
