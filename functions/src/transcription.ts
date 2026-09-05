import { createHash } from "node:crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  CHUNK_DURATION_MS,
  DEEPGRAM_USD_PER_MINUTE,
  REGION,
  TOKEN_TTL_SECONDS,
  database,
  deepgramApiKey,
  estimateTranscriptionCost,
  numeric,
  requireChunkIndex,
  requireId,
  requireMember,
  requireRecord,
  requireUserId,
  roundUsd,
  usageTotals,
  type ReservationResult,
  type UsageTotals,
} from "./shared.js";
import { releaseReservation } from "./usage.js";

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
        deepgramActualUsd: roundUsd(
          usage.deepgramActualUsd + estimatedCostUsd,
        ),
        deepgramReservedUsd: roundUsd(
          Math.max(0, usage.deepgramReservedUsd - estimatedCostUsd),
        ),
        geminiActualUsd: usage.geminiActualUsd,
        geminiReservedUsd: usage.geminiReservedUsd,
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

export async function reserveTranscription(
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
      deepgramActualUsd: usage.deepgramActualUsd,
      deepgramReservedUsd: roundUsd(
        usage.deepgramReservedUsd + estimatedCostUsd,
      ),
      geminiActualUsd: usage.geminiActualUsd,
      geminiReservedUsd: usage.geminiReservedUsd,
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
      provider: "deepgram",
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

export async function grantDeepgramToken(): Promise<{
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
    const providerError = await readDeepgramError(response);
    if (response.status === 403) {
      throw new HttpsError(
        "failed-precondition",
        "The Deepgram API key needs Member or higher permissions to create temporary transcription tokens. Create a Member key in Deepgram and update DEEPGRAM_API_KEY.",
        providerError,
      );
    }
    if (response.status === 401) {
      throw new HttpsError(
        "failed-precondition",
        "The Deepgram API key is invalid or expired. Replace DEEPGRAM_API_KEY with an active Member key.",
        providerError,
      );
    }
    throw new HttpsError(
      "unavailable",
      `Deepgram token grant failed with status ${response.status}. Try again shortly.`,
      providerError,
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

export async function readDeepgramError(
  response: Response,
): Promise<{ status: number; code?: string; message?: string }> {
  const result: { status: number; code?: string; message?: string } = {
    status: response.status,
  };
  try {
    const body = (await response.json()) as {
      err_code?: unknown;
      err_msg?: unknown;
    };
    if (typeof body.err_code === "string") result.code = body.err_code;
    if (typeof body.err_msg === "string") result.message = body.err_msg;
  } catch {
    // Provider errors are optional diagnostic context; the HTTP status remains
    // the authoritative signal when Deepgram returns a non-JSON response.
  }
  return result;
}
