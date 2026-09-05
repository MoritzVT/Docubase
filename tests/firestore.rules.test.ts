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
    projectId: "docubase-455a4",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
    storage: {
      rules: readFileSync("storage.rules", "utf8"),
      host: "127.0.0.1",
      port: 9199,
    },
  });
});

beforeEach(async () => {
  await Promise.all([
    environment.clearFirestore(),
    environment.clearStorage(),
  ]);
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
    recordedAt: timestamp,
    sourceModifiedAt: timestamp,
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

  it("allows only portable retained-frame records", async () => {
    await seedProject(["owner", "editor"]);
    const database = environment.authenticatedContext("editor").firestore();
    const clipReference = doc(database, "projects", "film", "clips", "clip-a");
    await setDoc(clipReference, portableClip());
    const frameReference = doc(
      clipReference,
      "visualFrames",
      "frame-000000001000",
    );
    const frame = {
      id: "frame-000000001000",
      projectId: "film",
      clipId: "clip-a",
      momentId: "moment-00000000",
      timestampMs: 1_000,
      width: 384,
      height: 216,
      fileSizeBytes: 12_345,
      changeScore: 0.42,
      stage: "ready",
      storagePath:
        "projects/film/clips/clip-a/frames/frame-000000001000.jpg",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await assertSucceeds(setDoc(frameReference, frame));
    await assertFails(
      setDoc(frameReference, {
        ...frame,
        localPath: "/tmp/docubase/frame.jpg",
      }),
    );
    await assertFails(
      setDoc(
        doc(clipReference, "visualFrames", "frame-other"),
        { ...frame, id: "frame-other" },
      ),
    );
    await assertFails(
      updateDoc(frameReference, {
        timestampMs: 9_000,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  it("keeps generated visual evidence server-owned but lets members edit metadata", async () => {
    await seedProject(["owner", "editor"]);
    await environment.withSecurityRulesDisabled(async (context) => {
      const clipReference = doc(
        context.firestore(),
        "projects",
        "film",
        "clips",
        "clip-a",
      );
      await setDoc(clipReference, {
        ...portableClip(),
        generatedDescription: "A cyclist approaches a mountain.",
        description: "A cyclist approaches a mountain.",
        generatedTags: ["cyclist"],
        tags: ["cyclist"],
        visualStage: "complete",
        visualUpdatedAt: new Date().toISOString(),
      });
      await setDoc(doc(clipReference, "visualMoments", "moment-00000000"), {
        id: "moment-00000000",
        projectId: "film",
        clipId: "clip-a",
        description: "A cyclist approaches a mountain.",
        tags: ["cyclist"],
        facets: { actions: ["cycling"] },
        stage: "complete",
        updatedAt: new Date().toISOString(),
      });
    });
    const database = environment.authenticatedContext("editor").firestore();
    const clipReference = doc(
      database,
      "projects",
      "film",
      "clips",
      "clip-a",
    );
    await assertSucceeds(
      updateDoc(clipReference, {
        description: "An editor-approved clip summary.",
        tags: ["bike", "mountain"],
        visualEditedAt: new Date().toISOString(),
        visualUpdatedAt: new Date().toISOString(),
      }),
    );
    await assertFails(
      updateDoc(clipReference, {
        generatedDescription: "Forged generated summary.",
        visualUpdatedAt: new Date().toISOString(),
      }),
    );
    const momentReference = doc(
      database,
      "projects",
      "film",
      "clips",
      "clip-a",
      "visualMoments",
      "moment-00000000",
    );
    await assertSucceeds(
      updateDoc(momentReference, {
        description: "A biker rides toward a mountain.",
        tags: ["bike", "mountain"],
        updatedAt: new Date().toISOString(),
      }),
    );
    await assertFails(
      updateDoc(momentReference, {
        facets: { actions: ["fabricated"] },
        updatedAt: new Date().toISOString(),
      }),
    );
    await assertFails(
      setDoc(
        doc(
          database,
          "projects",
          "film",
          "clips",
          "clip-a",
          "visualMoments",
          "forged",
        ),
        { id: "forged", projectId: "film", clipId: "clip-a" },
      ),
    );
  });

  it("keeps visual jobs server-owned", async () => {
    await seedProject(["owner", "editor"]);
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(
          context.firestore(),
          "projects",
          "film",
          "visualJobs",
          "job-a",
        ),
        { state: "running" },
      );
    });
    const database = environment.authenticatedContext("editor").firestore();
    await assertSucceeds(
      getDoc(doc(database, "projects", "film", "visualJobs", "job-a")),
    );
    await assertFails(
      setDoc(doc(database, "projects", "film", "visualJobs", "forged"), {
        state: "complete",
      }),
    );
  });

  it("rejects all direct client Storage access", async () => {
    await seedProject(["owner", "editor"]);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const path =
      "projects/film/clips/clip-a/frames/frame-000000001000.jpg";
    const metadata = {
      contentType: "image/jpeg",
      customMetadata: {
        projectId: "film",
        clipId: "clip-a",
        frameId: "frame-000000001000",
        momentId: "moment-00000000",
      },
    };
    const memberStorage = environment.authenticatedContext("editor").storage();
    await assertFails(
      Promise.resolve(memberStorage.ref(path).put(bytes, metadata)),
    );
    await assertFails(memberStorage.ref(path).getMetadata());

    const outsiderStorage =
      environment.authenticatedContext("outsider").storage();
    await assertFails(outsiderStorage.ref(path).getMetadata());
    await assertFails(
      Promise.resolve(outsiderStorage.ref(path).put(bytes, metadata)),
    );
    await assertFails(
      Promise.resolve(
        memberStorage
          .ref("projects/film/clips/clip-a/source-video.mov")
          .put(bytes, {
            contentType: "video/quicktime",
            customMetadata: metadata.customMetadata,
          }),
      ),
    );
    await assertFails(
      Promise.resolve(
        memberStorage
          .ref("projects/film/clips/clip-a/frames/wrong-name.jpg")
          .put(bytes, metadata),
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
