import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deleteApp, initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
} from "firebase/auth";
import {
  doc,
  getDoc,
  getFirestore,
  setDoc,
} from "firebase/firestore";

const requiredEnvironment = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
];
for (const key of requiredEnvironment) {
  if (!process.env[key]) throw new Error(`Missing ${key}.`);
}

const suffix = randomUUID();
const projectId = `smoke-${suffix}`;
const projectName = `Production smoke ${suffix}`;
const clipId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const analysisSmoke = process.env.DOCUBASE_SMOKE_ANALYSIS === "1";
const app = initializeApp({
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
});
const auth = getAuth(app);
const database = getFirestore(
  app,
  process.env.VITE_FIREBASE_DATABASE_ID || "default",
);
let deleteProject = null;
let projectCreated = false;

try {
  const credential = await createUserWithEmailAndPassword(
    auth,
    `docubase-smoke-${suffix}@example.com`,
    `Smoke-${randomUUID()}!`,
  );
  const idToken = await credential.user.getIdToken(true);
  const health = await callFunction("health", {}, idToken);
  if (!health.ok || health.project !== "docubase-455a4") {
    throw new Error("Production health callable returned unexpected metadata.");
  }
  deleteProject = (data) => callFunction("deleteProject", data, idToken);
  const timestamp = new Date().toISOString();
  await setDoc(doc(database, "projects", projectId), {
    ownerId: credential.user.uid,
    name: projectName,
    brief: "Temporary production authorization smoke test.",
    knownNames: [],
    terminology: [],
    budgetPerFootageHour: 0.5,
    memberIds: [credential.user.uid],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  projectCreated = true;
  await setDoc(doc(database, "projects", projectId, "clips", clipId), {
    id: clipId,
    projectId,
    fingerprint: clipId,
    filename: "smoke.mov",
    fileExtension: "mov",
    portableDirectoryHint: "",
    durationMs: 1_000,
    frameRate: { numerator: 25, denominator: 1, dropFrame: false },
    startTimecodeFrames: null,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    audioCodec: null,
    hasAudio: false,
    fileSizeBytes: 1_000,
    posterPath: null,
    stage: "ready",
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const uploadVisualFrame = (data) =>
    callFunction("uploadVisualFrame", data, idToken);
  const jpegBytes = await readFile(new URL(
    "../node_modules/highlight.js/styles/pojoaque.jpg",
    import.meta.url,
  ));
  const upload = await uploadVisualFrame({
    projectId,
    clipId,
    frameId: "frame-000000000000",
    momentId: "moment-00000000",
    timestampMs: 0,
    width: 140,
    height: 140,
    changeScore: 0,
    bytesBase64: jpegBytes.toString("base64"),
  });
  if (
    upload.storagePath !==
    `projects/${projectId}/clips/${clipId}/frames/frame-000000000000.jpg`
  ) {
    throw new Error("Production upload returned the wrong Storage path.");
  }
  const frame = await getDoc(
    doc(
      database,
      "projects",
      projectId,
      "clips",
      clipId,
      "visualFrames",
      "frame-000000000000",
    ),
  );
  if (!frame.exists()) {
    throw new Error("Production upload did not create its frame record.");
  }

  if (analysisSmoke) {
    await setDoc(
      doc(
        database,
        "projects",
        projectId,
        "clips",
        clipId,
        "transcriptUtterances",
        "utterance-1",
      ),
      {
        id: "utterance-1",
        projectId,
        clipId,
        chunkIndex: 0,
        startMs: 0,
        endMs: 900,
        speaker: 0,
        confidence: 1,
        text: "This interview discusses a community documentary project.",
        words: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );
    const submission = await callFunction("submitVisualAnalysis", {
      projectId,
      clipId,
      frames: [{
        id: "frame-000000000000",
        momentId: "moment-00000000",
        timestampMs: 0,
        fileSizeBytes: upload.fileSizeBytes,
        changeScore: 0,
      }],
      stability: {
        significantChangeCount: 0,
        significantChangeRatio: 0,
        medianChangeScore: 0,
        maximumChangeScore: 0,
      },
    }, idToken);
    const job = await getDoc(
      doc(database, "projects", projectId, "visualJobs", submission.jobId),
    );
    if (
      !job.exists() ||
      job.data().analysisVersion !== "4" ||
      job.data().phase !== "foundation" ||
      job.data().frameManifest?.length !== 1
    ) {
      throw new Error("Separated analysis submission was not persisted correctly.");
    }
    console.log("Production Goal 3.1 Batch submission smoke test passed.");
  }

  const deletion = await deleteProject({ projectId, confirmedName: projectName });
  if (!deletion.deleted) {
    throw new Error("Production project deletion did not complete.");
  }
  projectCreated = false;
  console.log("Production upload and project deletion smoke test passed.");
} finally {
  if (projectCreated && auth.currentUser && deleteProject) {
    try {
      await deleteProject({ projectId, confirmedName: projectName });
    } catch {
      // Leave the original failure visible; the temporary ID makes cleanup safe.
    }
  }
  if (auth.currentUser) {
    try {
      await deleteUser(auth.currentUser);
    } catch {
      // Authentication cleanup should not hide a pipeline failure.
    }
  }
  await deleteApp(app);
}

async function callFunction(name, data, idToken) {
  const response = await fetch(
    `https://us-central1-docubase-455a4.cloudfunctions.net/${name}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ data }),
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(
      payload.error?.message ||
        `Callable ${name} failed with status ${response.status}.`,
    );
  }
  return payload.result;
}
