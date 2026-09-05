import { onCall } from "firebase-functions/v2/https";
import { REGION, requireUserId } from "./shared.js";

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
