import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

let environment: RulesTestEnvironment;

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: "docubase-rules-test",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

beforeEach(async () => {
  await environment.clearFirestore();
});

afterAll(async () => {
  await environment.cleanup();
});

async function seedProject(memberIds = ["owner"]) {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "projects", "film"), {
      ownerId: "owner",
      name: "Film",
      brief: "",
      knownNames: [],
      terminology: [],
      budgetPerFootageHour: 0.5,
      memberIds,
      usage: { actualUsd: 0, reservedUsd: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
}

function portableClip() {
  const timestamp = new Date().toISOString();
  return {
    id: "clip-a",
    projectId: "film",
    fingerprint: "0123456789abcdef",
    filename: "A001.mov",
    fileExtension: "mov",
    portableDirectoryHint: "CARD_A",
    durationMs: 12_000,
    frameRate: { numerator: 25, denominator: 1, dropFrame: false },
    startTimecodeFrames: 90_000,
    width: 1_920,
    height: 1_080,
    videoCodec: "apch",
    audioCodec: "lpcm",
    hasAudio: true,
    fileSizeBytes: 1_000_000,
    posterPath: null,
    stage: "ready",
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("Docubase Firestore rules", () => {
  it("allows an owner to create a project containing themselves", async () => {
    const database = environment.authenticatedContext("owner").firestore();
    await assertSucceeds(
      setDoc(doc(database, "projects", "new-film"), {
        ownerId: "owner",
        memberIds: ["owner"],
      }),
    );
  });

  it("allows only members to read a project", async () => {
    await seedProject(["owner", "editor"]);
    const editor = environment.authenticatedContext("editor").firestore();
    const outsider = environment.authenticatedContext("outsider").firestore();
    await assertSucceeds(getDoc(doc(editor, "projects", "film")));
    await assertFails(getDoc(doc(outsider, "projects", "film")));
  });

  it("supports the member-scoped project-list query", async () => {
    await seedProject(["owner", "editor"]);
    const editor = environment.authenticatedContext("editor").firestore();
    await assertSucceeds(
      getDocs(
        query(
          collection(editor, "projects"),
          where("memberIds", "array-contains", "editor"),
        ),
      ),
    );
  });

  it("allows portable clip metadata and rejects a local source path", async () => {
    await seedProject(["owner", "editor"]);
    const database = environment.authenticatedContext("editor").firestore();
    const clipReference = doc(database, "projects", "film", "clips", "clip-a");
    await assertSucceeds(setDoc(clipReference, portableClip()));
    await assertFails(
      setDoc(clipReference, {
        ...portableClip(),
        sourcePath: "/Volumes/Documentary/CARD_A/A001.mov",
      }),
    );
  });

  it("allows members to sync transcripts but never local audio paths", async () => {
    await seedProject(["owner", "editor"]);
    const database = environment.authenticatedContext("editor").firestore();
    const clipReference = doc(database, "projects", "film", "clips", "clip-a");
    await setDoc(clipReference, portableClip());
    const chunkReference = doc(
      clipReference,
      "transcriptChunks",
      "chunk-0000",
    );
    await assertSucceeds(
      setDoc(chunkReference, {
        id: "chunk-0000",
        projectId: "film",
        clipId: "clip-a",
        chunkIndex: 0,
        startMs: 0,
        durationMs: 12_000,
        requestId: "deepgram-request",
        model: "nova-3",
        modelVersion: "current",
        language: "en",
        utteranceCount: 1,
        wordCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await assertFails(
      setDoc(chunkReference, {
        id: "chunk-0000",
        projectId: "film",
        clipId: "clip-a",
        audioPath: "/tmp/docubase/chunk-0000.m4a",
      }),
    );

    await assertSucceeds(
      setDoc(
        doc(
          clipReference,
          "transcriptUtterances",
          "chunk-0000-utterance-000000",
        ),
        {
          id: "chunk-0000-utterance-000000",
          projectId: "film",
          clipId: "clip-a",
          chunkIndex: 0,
          startMs: 100,
          endMs: 2_000,
          speaker: 0,
          confidence: 0.98,
          text: "A short transcript.",
          words: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ),
    );
  });

  it("prevents outsiders from reading transcripts", async () => {
    await seedProject(["owner", "editor"]);
    const owner = environment.authenticatedContext("owner").firestore();
    const ownerClip = doc(owner, "projects", "film", "clips", "clip-a");
    await setDoc(ownerClip, portableClip());
    await setDoc(doc(ownerClip, "transcriptChunks", "chunk-0000"), {
      id: "chunk-0000",
      projectId: "film",
      clipId: "clip-a",
    });

    const outsider = environment.authenticatedContext("outsider").firestore();
    await assertFails(
      getDoc(
        doc(
          outsider,
          "projects",
          "film",
          "clips",
          "clip-a",
          "transcriptChunks",
          "chunk-0000",
        ),
      ),
    );
  });

  it("keeps usage accounting server-owned", async () => {
    await seedProject(["owner"]);
    const database = environment.authenticatedContext("owner").firestore();
    await assertFails(
      updateDoc(doc(database, "projects", "film"), {
        "usage.actualUsd": 1,
        "usage.reservedUsd": 0,
      }),
    );
    await assertFails(
      setDoc(
        doc(database, "projects", "film", "usageEvents", "forged-event"),
        { actualCostUsd: 0 },
      ),
    );
    await assertFails(
      setDoc(
        doc(
          database,
          "projects",
          "film",
          "usageReservations",
          "forged-reservation",
        ),
        { status: "complete" },
      ),
    );
  });
});
