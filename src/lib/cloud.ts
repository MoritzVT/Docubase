import {
  collection,
  doc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import type {
  AnalysisMode,
  ClipManifest,
  ClipVisualMetadata,
  Project,
  TranscriptChunkPayload,
  VisualAnalysisJob,
  VisualFrameDocument,
  VisualMoment,
  DeleteProjectResponse,
  SearchIndexStatus,
  SearchIndexEstimate,
  SearchScope,
  SemanticSearchResponse,
} from "./contracts";
import {
  ClipVisualMetadataSchema,
  ProjectSchema,
  VisualAnalysisJobSchema,
  VisualMomentSchema,
  SearchIndexStatusSchema,
  SearchIndexEstimateSchema,
  SemanticSearchResponseSchema,
} from "./contracts";
import { requireDb, requireFunctions } from "./firebase";

export async function listCloudProjects(userId: string): Promise<Project[]> {
  const snapshot = await getDocs(
    query(
      collection(requireDb(), "projects"),
      where("memberIds", "array-contains", userId),
    ),
  );
  return snapshot.docs
    .map((item) => ProjectSchema.safeParse({ id: item.id, ...item.data() }))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveProject(project: Project): Promise<void> {
  const { id, ...portableProject } = project;
  await setDoc(doc(requireDb(), "projects", id), portableProject, {
    merge: true,
  });
}

export async function deleteCloudProject(
  projectId: string,
  confirmedName: string,
): Promise<DeleteProjectResponse> {
  const callable = httpsCallable<
    { projectId: string; confirmedName: string },
    DeleteProjectResponse
  >(requireFunctions(), "deleteProject");
  return (await callable({ projectId, confirmedName })).data;
}

export async function syncClipManifests(
  clips: ClipManifest[],
): Promise<void> {
  const database = requireDb();
  for (let offset = 0; offset < clips.length; offset += 400) {
    const batch = writeBatch(database);
    clips.slice(offset, offset + 400).forEach((clip) => {
      const { posterPath: _localPosterPath, ...portableClip } = clip;
      batch.set(
        doc(database, "projects", clip.projectId, "clips", clip.id),
        { ...portableClip, posterPath: null },
        { merge: true },
      );
    });
    await batch.commit();
  }
}

export async function syncTranscriptChunk(
  payload: TranscriptChunkPayload,
): Promise<void> {
  const database = requireDb();
  const clipReference = doc(
    database,
    "projects",
    payload.chunk.projectId,
    "clips",
    payload.chunk.clipId,
  );
  const utterancesReference = collection(
    clipReference,
    "transcriptUtterances",
  );
  const existing = await getDocs(
    query(
      utterancesReference,
      where("chunkIndex", "==", payload.chunk.chunkIndex),
    ),
  );
  for (let offset = 0; offset < existing.docs.length; offset += 400) {
    const batch = writeBatch(database);
    existing.docs.slice(offset, offset + 400).forEach((item) => {
      batch.delete(item.ref);
    });
    await batch.commit();
  }

  await setDoc(
    doc(clipReference, "transcriptChunks", payload.chunk.id),
    payload.chunk,
  );
  for (let offset = 0; offset < payload.utterances.length; offset += 350) {
    const batch = writeBatch(database);
    payload.utterances.slice(offset, offset + 350).forEach((utterance) => {
      batch.set(
        doc(utterancesReference, utterance.id),
        utterance,
      );
    });
    await batch.commit();
  }
}

export async function syncVisualFrame(
  frame: VisualFrameDocument,
): Promise<void> {
  await setDoc(
    doc(
      requireDb(),
      "projects",
      frame.projectId,
      "clips",
      frame.clipId,
      "visualFrames",
      frame.id,
    ),
    frame,
  );
}

export async function listCloudClipVisualMetadata(
  projectId: string,
): Promise<ClipVisualMetadata[]> {
  const snapshot = await getDocs(
    collection(requireDb(), "projects", projectId, "clips"),
  );
  return snapshot.docs
    .map((item) =>
      ClipVisualMetadataSchema.safeParse({
        clipId: item.id,
        generatedDescription: item.data().generatedDescription ?? "",
        description: item.data().description ?? "",
        generatedTags: item.data().generatedTags ?? [],
        tags: item.data().tags ?? [],
        generatedTranscriptDescription:
          item.data().generatedTranscriptDescription ?? "",
        generatedVisualDescription:
          item.data().generatedVisualDescription ?? "",
        generatedTranscriptTags: item.data().generatedTranscriptTags ?? [],
        generatedVisualTags: item.data().generatedVisualTags ?? [],
        keywordProvenance: item.data().keywordProvenance ?? [],
        analysisRoute: item.data().analysisRoute ?? null,
        analysisVersion: item.data().analysisVersion ?? null,
        visualStage: item.data().visualStage ?? "not_started",
        visualFacets: item.data().visualFacets ?? {
          contentTypes: [],
          speechStates: [],
          settings: [],
          weather: [],
          colors: [],
          moods: [],
          actions: [],
        },
      }),
    )
    .filter((result) => result.success)
    .map((result) => result.data);
}

export async function updateClipVisualMetadata(
  projectId: string,
  clipId: string,
  description: string,
  tags: string[],
): Promise<void> {
  const timestamp = new Date().toISOString();
  await setDoc(
    doc(requireDb(), "projects", projectId, "clips", clipId),
    {
      description: description.trim().slice(0, 3_000),
      tags: tags
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean)
        .slice(0, 40),
      visualEditedAt: timestamp,
      visualUpdatedAt: timestamp,
    },
    { merge: true },
  );
}

export async function listCloudVisualMoments(
  projectId: string,
  clipId: string,
): Promise<VisualMoment[]> {
  const snapshot = await getDocs(
    collection(
      requireDb(),
      "projects",
      projectId,
      "clips",
      clipId,
      "visualMoments",
    ),
  );
  return snapshot.docs
    .map((item) =>
      VisualMomentSchema.safeParse({ id: item.id, ...item.data() }),
    )
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((left, right) => left.startMs - right.startMs);
}

export async function updateVisualMomentMetadata(
  moment: VisualMoment,
  description: string,
  tags: string[],
): Promise<void> {
  await setDoc(
    doc(
      requireDb(),
      "projects",
      moment.projectId,
      "clips",
      moment.clipId,
      "visualMoments",
      moment.id,
    ),
    {
      description: description.trim().slice(0, 1_000),
      tags: tags
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean)
        .slice(0, 40),
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

export async function listVisualAnalysisJobs(
  projectId: string,
): Promise<VisualAnalysisJob[]> {
  const snapshot = await getDocs(
    collection(requireDb(), "projects", projectId, "visualJobs"),
  );
  return snapshot.docs
    .map((item) =>
      VisualAnalysisJobSchema.safeParse({ id: item.id, ...item.data() }),
    )
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getSearchIndexStatus(
  projectId: string,
): Promise<SearchIndexStatus> {
  const callable = httpsCallable<{ projectId: string }, unknown>(
    requireFunctions(),
    "getSearchIndexStatus",
  );
  return SearchIndexStatusSchema.parse((await callable({ projectId })).data);
}

export async function cancelSearchIndex(
  projectId: string,
): Promise<SearchIndexStatus> {
  const callable = httpsCallable<{ projectId: string }, unknown>(
    requireFunctions(),
    "cancelSearchIndex",
  );
  return SearchIndexStatusSchema.parse((await callable({ projectId })).data);
}

export async function estimateSearchIndex(
  projectId: string,
): Promise<SearchIndexEstimate> {
  const callable = httpsCallable<{ projectId: string }, unknown>(
    requireFunctions(),
    "estimateSearchIndex",
  );
  return SearchIndexEstimateSchema.parse((await callable({ projectId })).data);
}

export async function startSearchIndex(
  projectId: string,
  mode: AnalysisMode,
): Promise<SearchIndexStatus> {
  const callable = httpsCallable<{ projectId: string; mode: AnalysisMode }, unknown>(
    requireFunctions(),
    "startSearchIndex",
  );
  return SearchIndexStatusSchema.parse((await callable({ projectId, mode })).data);
}

export async function refreshSearchIndex(
  projectId: string,
): Promise<SearchIndexStatus> {
  const callable = httpsCallable<{ projectId: string }, unknown>(
    requireFunctions(),
    "refreshSearchIndex",
  );
  return SearchIndexStatusSchema.parse((await callable({ projectId })).data);
}

export async function searchProject(
  projectId: string,
  query: string,
  scope: SearchScope,
): Promise<SemanticSearchResponse> {
  const callable = httpsCallable<
    { projectId: string; query: string; scope: SearchScope; limit: number },
    unknown
  >(requireFunctions(), "searchProject");
  return SemanticSearchResponseSchema.parse(
    (await callable({ projectId, query, scope, limit: 20 })).data,
  );
}
