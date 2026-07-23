import {
  collection,
  doc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import type { ClipManifest, Project } from "./contracts";
import { ProjectSchema } from "./contracts";
import { requireDb } from "./firebase";

export async function listCloudProjects(userId: string): Promise<Project[]> {
  const snapshot = await getDocs(
    query(
      collection(requireDb(), "projects"),
      where("memberIds", "array-contains", userId),
    ),
  );
  return snapshot.docs
    .map((item) => ProjectSchema.safeParse({ id: item.id, ...item.data() }))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveProject(project: Project): Promise<void> {
  const { id, ...portableProject } = project;
  await setDoc(doc(requireDb(), "projects", id), portableProject);
}

export async function syncClipManifests(
  clips: ClipManifest[],
): Promise<void> {
  const database = requireDb();
  for (let offset = 0; offset < clips.length; offset += 400) {
    const batch = writeBatch(database);
    clips.slice(offset, offset + 400).forEach((clip) => {
      const { posterPath: _localPosterPath, ...portableClip } = clip;
      batch.set(
        doc(database, "projects", clip.projectId, "clips", clip.id),
        { ...portableClip, posterPath: null },
      );
    });
    await batch.commit();
  }
}
