import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  getAuth,
} from "firebase/auth";
import { doc, getFirestore, setDoc } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

const app = initializeApp({
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
});
const auth = getAuth(app);
const database = getFirestore(app, process.env.VITE_FIREBASE_DATABASE_ID || "default");
const functions = getFunctions(app, "us-central1");
const suffix = randomUUID().slice(0, 8);
const email = `docubase-e2e-${suffix}@example.com`;
const password = `E2e-${randomUUID()}-aA1!`;
const projectId = `semantic-e2e-${suffix}`;
const projectName = `Semantic E2E ${suffix}`;
let user;
let projectCreated = false;

const call = (name, data) => httpsCallable(functions, name)(data).then((result) => result.data);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const retryCall = async (name, data) => {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await call(name, data);
    } catch (error) {
      lastError = error;
      if (!["functions/deadline-exceeded", "functions/unavailable", "functions/internal"].includes(error.code)) {
        throw error;
      }
      await wait(10_000);
    }
  }
  throw lastError;
};

try {
  user = (await createUserWithEmailAndPassword(auth, email, password)).user;
  const now = new Date().toISOString();
  await setDoc(doc(database, "projects", projectId), {
    ownerId: user.uid,
    name: projectName,
    brief: "Temporary semantic search integration test.",
    knownNames: [],
    terminology: [],
    budgetPerFootageHour: 0.01,
    memberIds: [user.uid],
    createdAt: now,
    updatedAt: now,
  });
  projectCreated = true;

  const clips = [
    {
      id: "mountain-ride",
      filename: "MOUNTAIN_RIDE.MP4",
      durationMs: 92_000,
      description: "A cyclist climbs a mountain road while raising funds for climate projects.",
      tags: ["cycling", "mountain", "climate fundraising", "outdoors"],
      utterances: [
        ["u1", 2_000, 12_000, "We are riding toward the mountain to raise money for local climate projects."],
        ["u2", 48_000, 57_000, "The climb is difficult, but the fundraiser brings the community together."],
      ],
    },
    {
      id: "shelter-interview",
      filename: "SHELTER_INTERVIEW.MOV",
      durationMs: 48_000,
      description: "An interview about a shelter dog finding a permanent home after a long wait.",
      tags: ["interview", "shelter dog", "adoption"],
      utterances: [
        ["u1", 3_000, 16_000, "After two hundred and seventy days in the animal shelter, Max was finally adopted."],
      ],
    },
  ];
  for (const clip of clips) {
    await setDoc(doc(database, "projects", projectId, "clips", clip.id), {
      id: clip.id,
      projectId,
      fingerprint: `${clip.id}-0000000000000000`,
      filename: clip.filename,
      fileExtension: clip.filename.split(".").at(-1)?.toLowerCase(),
      portableDirectoryHint: "E2E",
      durationMs: clip.durationMs,
      frameRate: { numerator: 24, denominator: 1, dropFrame: false },
      startTimecodeFrames: 0,
      recordedAt: null,
      sourceModifiedAt: null,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
      fileSizeBytes: 1_000,
      posterPath: null,
      stage: "ready",
      error: null,
      description: clip.description,
      tags: clip.tags,
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, startMs, endMs, text] of clip.utterances) {
      await setDoc(doc(
        database,
        "projects",
        projectId,
        "clips",
        clip.id,
        "transcriptUtterances",
        id,
      ), {
        id,
        projectId,
        clipId: clip.id,
        chunkIndex: 0,
        startMs,
        endMs,
        speaker: 0,
        confidence: 1,
        text,
        words: [],
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Production defaults to discounted asynchronous Batch. This one-off test
  // uses the same model/indexing code through Standard so CI does not wait up
  // to 24 hours for provider scheduling.
  let status = await call("startSearchIndex", { projectId, mode: "fast" });
  console.log(`index started: ${status.totalRecords} records in ${status.totalBatches} batch`);
  for (let attempt = 0; attempt < 60 && !["complete", "failed"].includes(status.state); attempt += 1) {
    await wait(10_000);
    status = await call("refreshSearchIndex", { projectId });
    console.log(`index status: ${status.state} (${status.completedBatches}/${status.totalBatches})`);
  }
  if (status.state !== "complete") {
    throw new Error(status.error || `index did not complete: ${status.state}`);
  }

  const semantic = await retryCall("searchProject", {
    projectId,
    query: "a cyclist climbing toward a mountain for a climate fundraiser",
    scope: "all",
    limit: 10,
  });
  if (semantic.results[0]?.clipId !== "mountain-ride") {
    throw new Error(`unexpected semantic result: ${semantic.results[0]?.clipId ?? "none"}`);
  }
  const exact = await retryCall("searchProject", {
    projectId,
    query: "MOUNTAIN_RIDE.MP4",
    scope: "all",
    limit: 10,
  });
  if (!exact.results[0]?.exactFilename || exact.results[0]?.clipId !== "mountain-ride") {
    throw new Error("exact filename result was not pinned");
  }
  const spoken = await retryCall("searchProject", {
    projectId,
    query: "an animal waiting a long time to be adopted",
    scope: "spoken",
    limit: 10,
  });
  if (spoken.results[0]?.clipId !== "shelter-interview" || spoken.results[0]?.kind !== "spoken") {
    throw new Error("spoken search did not return transcript evidence");
  }
  const visual = await retryCall("searchProject", {
    projectId,
    query: "a dog outdoors",
    scope: "visual",
    limit: 10,
  });
  if (visual.results.length !== 0) throw new Error("visual scope returned non-visual evidence");
  console.log("semantic, exact filename, spoken scope, and visual scope checks passed");
} finally {
  if (projectCreated) {
    await call("deleteProject", { projectId, confirmedName: projectName }).catch((error) => {
      console.error(`test project cleanup failed: ${error.message}`);
    });
  }
  if (user) await deleteUser(user).catch(() => undefined);
}
