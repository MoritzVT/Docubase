import { createHash } from "node:crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  MAX_VISUAL_FRAME_BYTES,
  REGION,
  VISUAL_MOMENT_DURATION_MS,
  arrayStrings,
  bucket,
  database,
  geminiApiKey,
  numeric,
  requireBoundedNumber,
  requireGeminiClient,
  requireId,
  requireMember,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireProjectOwner,
  requireRecord,
  requireUserId,
  requireVisualFrameBytes,
  uniqueStrings,
} from "./shared.js";

export const uploadVisualFrame = onCall(
  {
    region: REGION,
    memory: "256MiB",
    maxInstances: 10,
    timeoutSeconds: 30,
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const clipId = requireId(data.clipId, "clipId");
    const frameId = requireId(data.frameId, "frameId");
    const momentId = requireId(data.momentId, "momentId");
    const timestampMs = requireNonNegativeInteger(
      data.timestampMs,
      "timestampMs",
    );
    const width = requirePositiveInteger(data.width, "width", 384);
    const height = requirePositiveInteger(data.height, "height", 384);
    const changeScore = requireBoundedNumber(data.changeScore, "changeScore");
    const bytes = requireVisualFrameBytes(data.bytesBase64);
    const expectedFrameId =
      `frame-${timestampMs.toString().padStart(12, "0")}`;
    const expectedMomentId =
      `moment-${Math.floor(timestampMs / VISUAL_MOMENT_DURATION_MS)
        .toString()
        .padStart(8, "0")}`;
    if (frameId !== expectedFrameId || momentId !== expectedMomentId) {
      throw new HttpsError(
        "invalid-argument",
        "The frame timestamp does not match its frame or moment identifier.",
      );
    }

    const projectReference = database.doc(`projects/${projectId}`);
    const clipReference = projectReference.collection("clips").doc(clipId);
    const [projectSnapshot, clipSnapshot] = await Promise.all([
      projectReference.get(),
      clipReference.get(),
    ]);
    requireMember(projectSnapshot.data(), userId);
    if (!clipSnapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Sync clip metadata before uploading visual frames.",
      );
    }
    const clipDurationMs = numeric(clipSnapshot.data()?.durationMs);
    if (timestampMs > clipDurationMs + 1_000) {
      throw new HttpsError(
        "invalid-argument",
        "The visual frame timestamp is outside the clip duration.",
      );
    }

    const storagePath =
      `projects/${projectId}/clips/${clipId}/frames/${frameId}.jpg`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const timestamp = new Date().toISOString();
    await bucket.file(storagePath).save(bytes, {
      resumable: false,
      contentType: "image/jpeg",
      metadata: {
        cacheControl: "private,max-age=31536000,immutable",
        metadata: {
          projectId,
          clipId,
          frameId,
          momentId,
          sha256,
        },
      },
    });
    await clipReference.collection("visualFrames").doc(frameId).set({
      id: frameId,
      projectId,
      clipId,
      momentId,
      timestampMs,
      width,
      height,
      fileSizeBytes: bytes.byteLength,
      changeScore,
      stage: "ready",
      storagePath,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      storagePath,
      fileSizeBytes: bytes.byteLength,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  },
);

export const deleteProject = onCall(
  {
    region: REGION,
    memory: "512MiB",
    maxInstances: 2,
    timeoutSeconds: 540,
    secrets: [geminiApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const confirmedName = String(data.confirmedName ?? "");
    const projectReference = database.doc(`projects/${projectId}`);
    const [projectSnapshot, jobsSnapshot, searchJobsSnapshot] = await Promise.all([
      projectReference.get(),
      projectReference.collection("visualJobs").get(),
      projectReference.collection("searchIndexJobs").get(),
    ]);
    const project = requireProjectOwner(projectSnapshot.data(), userId);
    if (
      confirmedName.length < 1 ||
      confirmedName !== String(project.name ?? "")
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Enter the exact project name to confirm deletion.",
      );
    }

    const searchBatchSnapshots = await Promise.all(
      searchJobsSnapshot.docs.map((snapshot) =>
        snapshot.ref.collection("batches").get()),
    );
    const activeBatchNames = uniqueStrings(
      [
        ...jobsSnapshot.docs.flatMap((snapshot) => {
        const job = snapshot.data();
        if (!["pending", "running"].includes(String(job.state))) return [];
        if (job.analysisMode === "fast") return [];
        return [
          String(job.batchName ?? ""),
          ...arrayStrings(job.batchNames),
        ];
        }),
        ...searchBatchSnapshots.flatMap((snapshot) =>
          snapshot.docs.flatMap((document) =>
            TERMINAL_SEARCH_STATES.has(String(document.data().state))
              ? []
              : [String(document.data().batchName ?? "")],
          )),
      ],
      10_000,
    );
    let canceledBatchCount = 0;
    if (activeBatchNames.length > 0) {
      const ai = requireGeminiClient();
      const cancellations = await Promise.allSettled(
        activeBatchNames.map((name) => ai.batches.cancel({ name })),
      );
      canceledBatchCount = cancellations.filter(
        (result) => result.status === "fulfilled",
      ).length;
    }

    await bucket.deleteFiles({ prefix: `projects/${projectId}/` });
    await database.recursiveDelete(projectReference);
    return {
      deleted: true,
      canceledBatchCount,
      uncanceledBatchCount: activeBatchNames.length - canceledBatchCount,
    };
  },
);

const TERMINAL_SEARCH_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
]);
