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
});
