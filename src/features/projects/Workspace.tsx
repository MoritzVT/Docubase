import {
  FilePlus2,
  Film,
  ImagePlus,
  LoaderCircle,
  LogOut,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { signOut, type User } from "firebase/auth";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Brand, LoadingBlock, Notice } from "../../components/SharedUi";
import { ThemeToggle } from "../../components/Theme";
import { deleteCloudProject, listCloudProjects, saveProject } from "../../lib/cloud";
import type { LocalProject, Project } from "../../lib/contracts";
import { requireAuth } from "../../lib/firebase";
import { formatDuration } from "../../lib/format";
import {
  chooseContextTextFiles,
  chooseProjectThumbnail,
  deleteLocalProject,
  importProjectAsset,
  isTauri,
  listLocalClips,
  listLocalProjects,
  posterSource,
  readProjectContext,
  upsertLocalProject,
} from "../../lib/native";
import { readableError } from "../../lib/presentation";
import { CatalogScreen } from "../catalog/CatalogScreen";

function splitTerms(value: string): string[] {
  return value
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
}

function shortProjectDescription(summary: string, brief: string): string {
  const words = (summary || brief).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "No project description yet.";
  const shortened = words.slice(0, 6).join(" ");
  return words.length > 6 ? `${shortened}…` : shortened;
}

export function Workspace({ user }: { user: User }) {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProject, setSelectedProject] =
    useState<LocalProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalProject | null>(null);
  const [editTarget, setEditTarget] = useState<LocalProject | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectThumbnails, setProjectThumbnails] = useState<
    Record<string, string | null>
  >({});

  const refreshProjects = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const existingLocalProjects = (await listLocalProjects()).filter(
        (project) => project.memberIds.includes(user.uid),
      );
      const existingLocalById = new Map(
        existingLocalProjects.map((project) => [project.id, project]),
      );
      let cloudProjects: Project[] = [];
      try {
        cloudProjects = await listCloudProjects(user.uid);
        await Promise.all(
          cloudProjects.map((project) => {
            const local = existingLocalById.get(project.id);
            return upsertLocalProject({
              ...project,
              clipCount: local?.clipCount ?? 0,
              totalDurationMs: local?.totalDurationMs ?? 0,
              thumbnailPath: local?.thumbnailPath ?? null,
              contextResourcePaths: local?.contextResourcePaths ?? [],
            });
          }),
        );
      } catch (error) {
        setNotice(`Project data is temporarily unavailable: ${readableError(error)}`);
      }

      const localProjects = (await listLocalProjects()).filter(
        (project) => project.memberIds.includes(user.uid),
      );
      const localById = new Map(
        localProjects.map((project) => [project.id, project]),
      );
      const merged =
        cloudProjects.length > 0
          ? cloudProjects.map((project) => ({
              ...project,
              clipCount: localById.get(project.id)?.clipCount ?? 0,
              totalDurationMs:
                localById.get(project.id)?.totalDurationMs ?? 0,
              thumbnailPath: localById.get(project.id)?.thumbnailPath ?? null,
              contextResourcePaths:
                localById.get(project.id)?.contextResourcePaths ?? [],
            }))
          : localProjects;
      setProjects(merged);
      const thumbnails = await Promise.all(
        merged.map(async (project) => {
          const clips = await listLocalClips(project.id);
          const firstClip = [...clips].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt)
          )[0];
          return [
            project.id,
            project.thumbnailPath ?? firstClip?.posterPath ?? null,
          ] as const;
        }),
      );
      setProjectThumbnails(Object.fromEntries(thumbnails));
      setSelectedProject((current) =>
        current
          ? merged.find((project) => project.id === current.id) ?? null
          : null,
      );
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  if (selectedProject) {
    return (
      <CatalogScreen
        onBack={() => {
          setSelectedProject(null);
          void refreshProjects();
        }}
        project={selectedProject}
        user={user}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="topbar-actions">
          <ThemeToggle />
          <span className="account-label">{user.email}</span>
          <button
            aria-label="Sign out"
            className="icon-button"
            onClick={() => void signOut(requireAuth())}
            title="Sign out"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="page-heading">
        <div>
          <h1>Documentary projects</h1>
          <p>
            Understand, organize, and search documentary footage while staying
            local.
          </p>
        </div>
        <button
          className="primary-button compact"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={17} />
          New project
        </button>
      </section>

      {notice && <Notice tone="warning">{notice}</Notice>}
      {!isTauri && (
        <Notice tone="warning">
          Open this interface in the Docubase desktop app to import and relink
          footage.
        </Notice>
      )}

      {loading ? (
        <LoadingBlock label="Loading projects…" />
      ) : projects.length === 0 ? (
        <button className="empty-state" onClick={() => setCreateOpen(true)}>
          <span className="empty-icon">
            <Film size={25} />
          </span>
          <strong>Create your first documentary project</strong>
          <span>Add the production brief now; attach footage folders next.</span>
        </button>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <article
              className="project-card"
              key={project.id}
            >
              {projectThumbnails[project.id] && (
                <img
                  alt=""
                  className="project-card-thumbnail"
                  src={posterSource(projectThumbnails[project.id]) ?? undefined}
                />
              )}
              <span className="project-card-overlay" />
              <button
                aria-label={`Open ${project.name}`}
                className="project-card-open"
                onClick={() => setSelectedProject(project)}
              >
                <div className="project-card-copy">
                  <h2>{project.name}</h2>
                  <div className="project-card-details">
                    <p>{shortProjectDescription(project.summary, project.brief)}</p>
                    <div className="project-stats">
                      <span>{project.clipCount} clips</span>
                      <span>{formatDuration(project.totalDurationMs)}</span>
                    </div>
                  </div>
                </div>
              </button>
              {project.ownerId === user.uid && (
                <div className="project-card-actions">
                  <button
                    aria-label={`Edit ${project.name}`}
                    className="project-edit-button"
                    onClick={() => setEditTarget(project)}
                    title="Edit project"
                    type="button"
                  >
                    <Settings2 size={16} />
                  </button>
                  <button
                    aria-label={`Delete ${project.name}`}
                    className="project-delete-button"
                    onClick={() => setDeleteTarget(project)}
                    title="Delete project"
                    type="button"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {createOpen && (
        <ProjectDialog
          onCancel={() => setCreateOpen(false)}
          onCreated={async (project) => {
            setCreateOpen(false);
            await refreshProjects();
            setSelectedProject(project);
          }}
          user={user}
        />
      )}
      {editTarget && (
        <ProjectDialog
          onCancel={() => setEditTarget(null)}
          onCreated={async () => {
            setEditTarget(null);
            await refreshProjects();
          }}
          project={editTarget}
          user={user}
        />
      )}
      {deleteTarget && (
        <DeleteProjectDialog
          onCancel={() => setDeleteTarget(null)}
          onDelete={async (confirmedName) => {
            const result = await deleteCloudProject(
              deleteTarget.id,
              confirmedName,
            );
            await deleteLocalProject(deleteTarget.id);
            setDeleteTarget(null);
            await refreshProjects();
            if (result.uncanceledBatchCount > 0) {
              setNotice(
                `${result.uncanceledBatchCount} provider batch job could not be canceled and may finish independently.`,
              );
            }
          }}
          project={deleteTarget}
        />
      )}
    </main>
  );
}

function ProjectDialog({
  user,
  onCancel,
  onCreated,
  project: existingProject,
}: {
  user: User;
  onCancel: () => void;
  onCreated: (project: LocalProject) => Promise<void>;
  project?: LocalProject;
}) {
  const [projectId] = useState(existingProject?.id ?? crypto.randomUUID());
  const [name, setName] = useState(existingProject?.name ?? "");
  const [summary, setSummary] = useState(existingProject?.summary ?? "");
  const [brief, setBrief] = useState(existingProject?.brief ?? "");
  const [knownNames, setKnownNames] = useState(
    existingProject?.knownNames.join(", ") ?? "",
  );
  const [terminology, setTerminology] = useState(
    existingProject?.terminology.join(", ") ?? "",
  );
  const [thumbnailPath, setThumbnailPath] = useState<string | null>(
    existingProject?.thumbnailPath ?? null,
  );
  const [newThumbnailPath, setNewThumbnailPath] = useState<string | null>(null);
  const [resources, setResources] = useState(() =>
    (existingProject?.contextResourceNames ?? [])
      .filter((resourceName) => resourceName.toLocaleLowerCase().endsWith(".txt"))
      .map((resourceName) => ({
      name: resourceName,
      path: existingProject?.contextResourcePaths.find((path) =>
        path.split(/[\\/]/).at(-1) === resourceName
      ) ?? null,
      isNew: false,
      })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryWordCount = summary.trim() ? summary.trim().split(/\s+/).length : 0;

  async function chooseThumbnail() {
    const selected = await chooseProjectThumbnail();
    if (selected) setNewThumbnailPath(selected);
  }

  async function addTextFiles() {
    const selected = await chooseContextTextFiles();
    if (selected.length === 0) return;
    setResources((current) => [
      ...current,
      ...selected
        .filter((path) => !current.some((item) => item.path === path))
        .map((path) => ({
          name: path.split(/[\\/]/).at(-1) ?? "context.txt",
          path,
          isNew: true,
        })),
    ].slice(0, 20));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (summaryWordCount > 6) {
      setError("Project in 6 words must contain six words or fewer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const timestamp = new Date().toISOString();
      const managedThumbnailPath = newThumbnailPath
        ? await importProjectAsset(projectId, newThumbnailPath, "thumbnail")
        : thumbnailPath;
      const managedResources = await Promise.all(resources.map(async (resource) => ({
        name: resource.name,
        path: resource.isNew && resource.path
          ? await importProjectAsset(projectId, resource.path, "context_text")
          : resource.path,
      })));
      const managedResourcePaths = managedResources.flatMap((resource) =>
        resource.path ? [resource.path] : []
      );
      const contextText = await readProjectContext(projectId, managedResourcePaths);
      const project: Project = {
        id: projectId,
        ownerId: existingProject?.ownerId ?? user.uid,
        name: name.trim(),
        summary: summary.trim(),
        brief: brief.trim(),
        knownNames: splitTerms(knownNames),
        terminology: splitTerms(terminology),
        contextResourceNames: managedResources.map((resource) => resource.name),
        contextText,
        budgetPerFootageHour: existingProject?.budgetPerFootageHour ?? 0.5,
        memberIds: existingProject?.memberIds ?? [user.uid],
        createdAt: existingProject?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const localProject: LocalProject = {
        ...project,
        clipCount: existingProject?.clipCount ?? 0,
        totalDurationMs: existingProject?.totalDurationMs ?? 0,
        thumbnailPath: managedThumbnailPath,
        contextResourcePaths: managedResourcePaths,
      };
      await saveProject(project);
      await upsertLocalProject(localProject);
      await onCreated(localProject);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form
        aria-label={existingProject ? "Edit project" : "Create project"}
        className="modal-card"
        onSubmit={submit}
      >
        <div>
          <span className="eyebrow">{existingProject ? "Project settings" : "New project"}</span>
          <h2>{existingProject ? "Edit project details" : "Add project details"}</h2>
          <p>
            Project details guide descriptions, tags, and search. Context files
            supply background information without becoming clip evidence.
          </p>
        </div>
        <label>
          Project name
          <input
            autoFocus
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Mountain Lines"
            required
            value={name}
          />
        </label>
        <label>
          Project in 6 words
          <input
            maxLength={120}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="A climate journey across melting glaciers"
            value={summary}
          />
          <small className={summaryWordCount > 6 ? "field-error" : "field-hint"}>
            {summaryWordCount} / 6 words
          </small>
        </label>
        <label>
          Production brief
          <textarea
            maxLength={5_000}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="A feature documentary following…"
            rows={4}
            value={brief}
          />
        </label>
        <div className="project-file-field">
          <div>
            <strong>Project thumbnail</strong>
            <span>{newThumbnailPath?.split(/[\\/]/).at(-1) ??
              thumbnailPath?.split(/[\\/]/).at(-1) ??
              "Automatically uses the first clip frame"}</span>
          </div>
          <div className="project-file-actions">
            {(newThumbnailPath || thumbnailPath) && (
              <button
                className="secondary-button compact"
                onClick={() => {
                  setNewThumbnailPath(null);
                  setThumbnailPath(null);
                }}
                type="button"
              >
                Use automatic
              </button>
            )}
            <button className="secondary-button compact" onClick={() => void chooseThumbnail()} type="button">
              <ImagePlus size={15} />
              Choose image
            </button>
          </div>
        </div>
        <details className="project-advanced">
          <summary>Advanced</summary>
          <div className="project-advanced-fields">
            <div className="form-columns">
              <label>
                People and organizations
                <input
                  onChange={(event) => setKnownNames(event.target.value)}
                  placeholder="Joost, Green Wheels"
                  value={knownNames}
                />
              </label>
              <label>
                Project terminology
                <input
                  onChange={(event) => setTerminology(event.target.value)}
                  placeholder="climate finance, peloton"
                  value={terminology}
                />
              </label>
            </div>
            <div className="project-resource-field">
              <div>
                <strong>Contextual text files</strong>
                <span>Original files stay local; up to 12,000 characters sync for analysis.</span>
              </div>
              <button className="secondary-button compact" onClick={() => void addTextFiles()} type="button">
                <FilePlus2 size={15} />
                Add text
              </button>
            </div>
            {resources.length > 0 && (
              <div className="project-resource-list">
                {resources.map((resource, index) => (
                  <div key={`${resource.name}-${index}`}>
                    <span>{resource.name}</span>
                    <button
                      aria-label={`Remove ${resource.name}`}
                      onClick={() => setResources((current) =>
                        current.filter((_, currentIndex) => currentIndex !== index)
                      )}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={busy} type="submit">
            {busy && <LoaderCircle className="spin" size={17} />}
            {existingProject ? "Save changes" : "Create project"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteProjectDialog({
  project,
  onCancel,
  onDelete,
}: {
  project: LocalProject;
  onCancel: () => void;
  onDelete: (confirmedName: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirmation === project.name;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(confirmation);
    } catch (caught) {
      setError(readableError(caught));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form
        aria-label="Delete project"
        className="modal-card delete-project-dialog"
        onSubmit={submit}
      >
        <div>
          <span className="eyebrow">Permanent deletion</span>
          <h2>Delete “{project.name}”?</h2>
          <p>
            This removes the local Docubase index, transcripts, retained
            thumbnails, and all associated project data. Your original footage files
            are never deleted. Docubase will also try to cancel active Gemini
            Batch jobs.
          </p>
        </div>
        <Notice tone="warning">
          This cannot be undone. Type <strong>{project.name}</strong> to
          continue.
        </Notice>
        <label>
          Project name
          <input
            autoComplete="off"
            autoFocus
            onChange={(event) => setConfirmation(event.target.value)}
            value={confirmation}
          />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="modal-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="danger-button"
            disabled={!matches || busy}
            type="submit"
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Trash2 size={17} />
            )}
            Delete project
          </button>
        </div>
      </form>
    </div>
  );
}
