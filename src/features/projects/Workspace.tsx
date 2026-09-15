import {
  Cloud,
  Film,
  LoaderCircle,
  LogOut,
  Plus,
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
  deleteLocalProject,
  isTauri,
  listLocalProjects,
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

export function Workspace({ user }: { user: User }) {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProject, setSelectedProject] =
    useState<LocalProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalProject | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      let cloudProjects: Project[] = [];
      try {
        cloudProjects = await listCloudProjects(user.uid);
        await Promise.all(
          cloudProjects.map((project) =>
            upsertLocalProject({
              ...project,
              clipCount: 0,
              totalDurationMs: 0,
            }),
          ),
        );
      } catch (error) {
        setNotice(`Cloud sync is offline: ${readableError(error)}`);
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
            }))
          : localProjects;
      setProjects(merged);
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
          <span className="eyebrow">Your workspaces</span>
          <h1>Documentary projects</h1>
          <p>
            Cloud-synced project details, paired with media that remains on
            your drives.
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
        <LoadingBlock label="Syncing projects…" />
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
              <button
                aria-label={`Open ${project.name}`}
                className="project-card-open"
                onClick={() => setSelectedProject(project)}
              >
                <div className="project-card-top">
                  <span className="project-monogram">
                    {project.name.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h2>{project.name}</h2>
                  <p>{project.brief || "No production brief yet."}</p>
                </div>
                <div className="project-stats">
                  <span>{project.clipCount} clips</span>
                  <span>{formatDuration(project.totalDurationMs)}</span>
                  <span className="sync-state">
                    <Cloud size={14} /> Synced
                  </span>
                </div>
              </button>
              {project.ownerId === user.uid && (
                <button
                  aria-label={`Delete ${project.name}`}
                  className="project-delete-button"
                  onClick={() => setDeleteTarget(project)}
                  title="Delete project"
                  type="button"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </article>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateProjectDialog
          onCancel={() => setCreateOpen(false)}
          onCreated={async (project) => {
            setCreateOpen(false);
            await refreshProjects();
            setSelectedProject(project);
          }}
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

function CreateProjectDialog({
  user,
  onCancel,
  onCreated,
}: {
  user: User;
  onCancel: () => void;
  onCreated: (project: LocalProject) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [knownNames, setKnownNames] = useState("");
  const [terminology, setTerminology] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const timestamp = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      ownerId: user.uid,
      name: name.trim(),
      brief: brief.trim(),
      knownNames: splitTerms(knownNames),
      terminology: splitTerms(terminology),
      budgetPerFootageHour: 0.5,
      memberIds: [user.uid],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const localProject: LocalProject = {
      ...project,
      clipCount: 0,
      totalDurationMs: 0,
    };
    try {
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
        aria-label="Create project"
        className="modal-card"
        onSubmit={submit}
      >
        <div>
          <span className="eyebrow">New workspace</span>
          <h2>Add project details</h2>
          <p>
            These details will guide transcript and visual analysis in later
            goals.
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
          Production brief
          <textarea
            maxLength={5_000}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="A feature documentary following…"
            rows={4}
            value={brief}
          />
        </label>
        <div className="form-columns">
          <label>
            People and organisations
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
        {error && <Notice tone="error">{error}</Notice>}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={busy} type="submit">
            {busy && <LoaderCircle className="spin" size={17} />}
            Create project
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
            thumbnails, and all cloud project data. Your original footage files
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
