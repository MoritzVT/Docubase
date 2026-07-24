import { createHash } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();

const database = getFirestore("default");
const deepgramApiKey = defineSecret("DEEPGRAM_API_KEY");

const REGION = "us-central1";
const CHUNK_DURATION_MS = 30 * 60 * 1_000;
const DEEPGRAM_USD_PER_MINUTE = 0.0048 + 0.002;
const TOKEN_TTL_SECONDS = 5 * 60;

interface UsageTotals {
  actualUsd: number;
  reservedUsd: number;
}

interface ReservationResult {
  reservationId: string;
  estimatedCostUsd: number;
  alreadyCompleted: boolean;
}

export const health = onCall(
  {
    region: REGION,
    memory: "256MiB",
    maxInstances: 2,
    timeoutSeconds: 15,
  },
  (request) => {
    requireUserId(request.auth?.uid);
    return {
      ok: true,
      project: process.env.GCLOUD_PROJECT ?? "docubase-455a4",
      region: REGION,
    };
  },
);

export const beginTranscriptionChunk = onCall(
  {
    region: REGION,
    memory: "256MiB",
    maxInstances: 5,
    timeoutSeconds: 30,
    secrets: [deepgramApiKey],
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const clipId = requireId(data.clipId, "clipId");
    const chunkIndex = requireChunkIndex(data.chunkIndex);

    const reservation = await reserveTranscription(
      userId,
      projectId,
      clipId,
      chunkIndex,
    );
    if (reservation.alreadyCompleted) {
      return {
        accessToken: null,
        expiresIn: 0,
        reservationId: reservation.reservationId,
        estimatedCostUsd: reservation.estimatedCostUsd,
        alreadyCompleted: true,
      };
    }

    try {
      const token = await grantDeepgramToken();
      return {
        accessToken: token.accessToken,
        expiresIn: token.expiresIn,
        reservationId: reservation.reservationId,
        estimatedCostUsd: reservation.estimatedCostUsd,
        alreadyCompleted: false,
      };
    } catch (error) {
      await releaseReservation(projectId, reservation.reservationId);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError(
        "unavailable",
        "Deepgram access is temporarily unavailable.",
      );
    }
  },
);

export const completeTranscriptionChunk = onCall(
  {
    region: REGION,
    memory: "256MiB",
    maxInstances: 5,
    timeoutSeconds: 30,
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const reservationId = requireId(data.reservationId, "reservationId");
    const requestId = requireId(data.requestId, "requestId");
    const projectReference = database.doc(`projects/${projectId}`);
    const reservationReference = projectReference
      .collection("usageReservations")
      .doc(reservationId);
    const usageEventReference = projectReference
      .collection("usageEvents")
      .doc(reservationId);

    return database.runTransaction(async (transaction) => {
      const [projectSnapshot, reservationSnapshot] = await Promise.all([
        transaction.get(projectReference),
        transaction.get(reservationReference),
      ]);
      const project = requireMember(projectSnapshot.data(), userId);
      if (!reservationSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          "The transcription reservation no longer exists.",
        );
      }
      const reservation = reservationSnapshot.data() ?? {};
      const estimatedCostUsd = numeric(reservation.estimatedCostUsd);
      const usage = usageTotals(project.usage);

      if (reservation.status === "complete") {
        return {
          actualCostUsd: estimatedCostUsd,
          projectActualUsd: usage.actualUsd,
          projectReservedUsd: usage.reservedUsd,
        };
      }
      if (reservation.status !== "reserved") {
        throw new HttpsError(
          "failed-precondition",
          "The transcription reservation is not active.",
        );
      }

      const nextUsage = {
        actualUsd: roundUsd(usage.actualUsd + estimatedCostUsd),
        reservedUsd: roundUsd(
          Math.max(0, usage.reservedUsd - estimatedCostUsd),
        ),
        updatedAt: new Date().toISOString(),
      };
      const completedAt = new Date().toISOString();
      transaction.set(
        projectReference,
        { usage: nextUsage },
        { merge: true },
      );
      transaction.set(
        reservationReference,
        {
          status: "complete",
          requestId,
          actualCostUsd: estimatedCostUsd,
          completedAt,
          updatedAt: completedAt,
        },
        { merge: true },
      );
      transaction.set(usageEventReference, {
        id: reservationId,
        projectId,
        clipId: reservation.clipId,
        chunkIndex: reservation.chunkIndex,
        provider: "deepgram",
        operation: "nova-3-transcription",
        durationMs: reservation.durationMs,
        estimatedCostUsd,
        actualCostUsd: estimatedCostUsd,
        requestId,
        createdAt: completedAt,
      });
      return {
        actualCostUsd: estimatedCostUsd,
        projectActualUsd: nextUsage.actualUsd,
        projectReservedUsd: nextUsage.reservedUsd,
      };
    });
  },
);

export const releaseTranscriptionChunk = onCall(
  {
    region: REGION,
    memory: "256MiB",
    maxInstances: 5,
    timeoutSeconds: 30,
  },
  async (request) => {
    const userId = requireUserId(request.auth?.uid);
    const data = requireRecord(request.data);
    const projectId = requireId(data.projectId, "projectId");
    const reservationId = requireId(data.reservationId, "reservationId");
    const projectSnapshot = await database.doc(`projects/${projectId}`).get();
    requireMember(projectSnapshot.data(), userId);
    await releaseReservation(projectId, reservationId);
    return { released: true };
  },
);

async function reserveTranscription(
  userId: string,
  projectId: string,
  clipId: string,
  chunkIndex: number,
): Promise<ReservationResult> {
  const projectReference = database.doc(`projects/${projectId}`);
  const clipReference = projectReference.collection("clips").doc(clipId);
  const reservationId = createHash("sha256")
    .update(`${projectId}:${clipId}:${chunkIndex}`)
    .digest("hex")
    .slice(0, 40);
  const reservationReference = projectReference
    .collection("usageReservations")
    .doc(reservationId);

  return database.runTransaction(async (transaction) => {
    const [projectSnapshot, clipSnapshot, reservationSnapshot] =
      await Promise.all([
        transaction.get(projectReference),
        transaction.get(clipReference),
        transaction.get(reservationReference),
      ]);
    const project = requireMember(projectSnapshot.data(), userId);
    if (!clipSnapshot.exists) {
      throw new HttpsError("not-found", "Clip metadata is not synced yet.");
    }
    const clip = clipSnapshot.data() ?? {};
    if (clip.hasAudio !== true) {
      throw new HttpsError(
        "failed-precondition",
        "This clip does not contain an audio track.",
      );
    }
    const clipDurationMs = numeric(clip.durationMs);
    const startMs = chunkIndex * CHUNK_DURATION_MS;
    if (clipDurationMs <= 0 || startMs >= clipDurationMs) {
      throw new HttpsError("invalid-argument", "Invalid transcription chunk.");
    }
    const durationMs = Math.min(CHUNK_DURATION_MS, clipDurationMs - startMs);
    const estimatedCostUsd = estimateTranscriptionCost(durationMs);
    const budgetPerFootageHour = numeric(project.budgetPerFootageHour);
    const chunkBudgetUsd =
      (durationMs / (60 * 60 * 1_000)) * budgetPerFootageHour;
    if (budgetPerFootageHour <= 0 || estimatedCostUsd > chunkBudgetUsd + 1e-6) {
      throw new HttpsError(
        "resource-exhausted",
        `This project allows $${budgetPerFootageHour.toFixed(2)} per footage hour, but Nova-3 with diarization is estimated at $${(DEEPGRAM_USD_PER_MINUTE * 60).toFixed(3)} per hour.`,
      );
    }

    const usage = usageTotals(project.usage);
    if (reservationSnapshot.exists) {
      const reservation = reservationSnapshot.data() ?? {};
      if (reservation.status === "complete") {
        return {
          reservationId,
          estimatedCostUsd,
          alreadyCompleted: true,
        };
      }
      if (reservation.status === "reserved") {
        return {
          reservationId,
          estimatedCostUsd,
          alreadyCompleted: false,
        };
      }
    }

    const nextUsage = {
      actualUsd: usage.actualUsd,
      reservedUsd: roundUsd(usage.reservedUsd + estimatedCostUsd),
      updatedAt: new Date().toISOString(),
    };
    const timestamp = new Date().toISOString();
    transaction.set(
      projectReference,
      { usage: nextUsage },
      { merge: true },
    );
    transaction.set(reservationReference, {
      id: reservationId,
      projectId,
      clipId,
      chunkIndex,
      startMs,
      durationMs,
      estimatedCostUsd,
      status: "reserved",
      createdBy: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      reservationId,
      estimatedCostUsd,
      alreadyCompleted: false,
    };
  });
}

async function releaseReservation(
  projectId: string,
  reservationId: string,
): Promise<void> {
  const projectReference = database.doc(`projects/${projectId}`);
  const reservationReference = projectReference
    .collection("usageReservations")
    .doc(reservationId);
  await database.runTransaction(async (transaction) => {
    const [projectSnapshot, reservationSnapshot] = await Promise.all([
      transaction.get(projectReference),
      transaction.get(reservationReference),
    ]);
    if (!projectSnapshot.exists || !reservationSnapshot.exists) return;
    const reservation = reservationSnapshot.data() ?? {};
    if (reservation.status !== "reserved") return;
    const usage = usageTotals(projectSnapshot.data()?.usage);
    const estimatedCostUsd = numeric(reservation.estimatedCostUsd);
    const timestamp = new Date().toISOString();
    transaction.set(
      projectReference,
      {
        usage: {
          actualUsd: usage.actualUsd,
          reservedUsd: roundUsd(
            Math.max(0, usage.reservedUsd - estimatedCostUsd),
          ),
          updatedAt: timestamp,
        },
      },
      { merge: true },
    );
    transaction.set(
      reservationReference,
      { status: "released", updatedAt: timestamp },
      { merge: true },
    );
  });
}

async function grantDeepgramToken(): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const apiKey = deepgramApiKey.value();
  if (!apiKey) {
    throw new HttpsError(
      "failed-precondition",
      "The Deepgram secret is not configured.",
    );
  }
  const response = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
  });
  if (!response.ok) {
    throw new HttpsError(
      "unavailable",
      `Deepgram token grant failed with status ${response.status}.`,
    );
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new HttpsError(
      "unavailable",
      "Deepgram did not return a temporary token.",
    );
  }
  return {
    accessToken: body.access_token,
    expiresIn: numeric(body.expires_in) || TOKEN_TTL_SECONDS,
  };
}

function requireUserId(userId: string | undefined): string {
  if (!userId) {
    throw new HttpsError("unauthenticated", "Sign in to use transcription.");
  }
  return userId;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Request data is required.");
  }
  return value as Record<string, unknown>;
}

function requireId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.includes("/")
  ) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value;
}

function requireChunkIndex(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100_000
  ) {
    throw new HttpsError("invalid-argument", "chunkIndex is invalid.");
  }
  return value;
}

function requireMember(
  project: FirebaseFirestore.DocumentData | undefined,
  userId: string,
): FirebaseFirestore.DocumentData {
  if (!project) {
    throw new HttpsError("not-found", "Project not found.");
  }
  const memberIds = Array.isArray(project.memberIds) ? project.memberIds : [];
  if (!memberIds.includes(userId)) {
    throw new HttpsError(
      "permission-denied",
      "You are not a member of this project.",
    );
  }
  return project;
}

function usageTotals(value: unknown): UsageTotals {
  const usage =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    actualUsd: roundUsd(Math.max(0, numeric(usage.actualUsd))),
    reservedUsd: roundUsd(Math.max(0, numeric(usage.reservedUsd))),
  };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateTranscriptionCost(durationMs: number): number {
  return roundUsd((durationMs / 60_000) * DEEPGRAM_USD_PER_MINUTE);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
