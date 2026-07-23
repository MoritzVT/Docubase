import { HttpsError, onCall } from "firebase-functions/v2/https";

export const health = onCall(
  {
    region: "us-central1",
    memory: "256MiB",
    maxInstances: 2,
    timeoutSeconds: 15,
  },
  (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in to call this function.");
    }
    return {
      ok: true,
      project: process.env.GCLOUD_PROJECT ?? "docubase-455a4",
      region: "us-central1",
    };
  },
);
