import {
  ArrowLeft,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clipboard,
  Cloud,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import {
  Fragment,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  listCloudProjects,
  saveProject,
  syncClipManifests,
  syncTranscriptChunk,
} from "./lib/cloud";
import type {
  ClipTranscriptSummary,
  ClipManifest,
  ImportProgress,
  LocalProject,
  Project,
  TranscriptSearchMatch,
  TranscriptUtterance,
  TranscriptionChunk,
} from "./lib/contracts";
import {
  firebaseConfigurationError,
  requireAuth,
} from "./lib/firebase";
import {
  formatBytes,
  formatDuration,
  formatFrameRate,
} from "./lib/format";
import {
  chooseFolder,
  completeTranscriptionChunk,
  extractTranscriptionChunk,
  isTauri,
  listLocalClips,
  listLocalProjects,
  listTranscriptSummaries,
  listTranscriptUtterances,
  listTranscriptionChunks,
  onImportProgress,
  posterSource,
  prepareTranscription,
  relinkFolder,
  revealClip,
  scanFolder,
  searchTranscripts,
  transcriptChunkPayload,
  transcribeAudioChunk,
  upsertLocalProject,
} from "./lib/native";
import { clipTimecode } from "./lib/timecode";
import {
  beginTranscriptionChunk,
  completeCloudTranscriptionChunk,
  estimateTranscriptionCost,
} from "./lib/transcription";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    if (firebaseConfigurationError) {
      setAuthLoading(false);
      return;
    }
    return onAuthStateChanged(requireAuth(), (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
    });
  }, []);

  if (firebaseConfigurationError) {
    return <ConfigurationScreen message={firebaseConfigurationError} />;
  }
  if (authLoading) return <LoadingScreen label="Opening Docubase…" />;
  if (!user) return <AuthScreen />;
  return <Workspace user={user} />;
}

function ConfigurationScreen({ message }: { message: string }) {
  return (
    <main className="centered-shell">
      <section className="setup-card">
        <Brand />
        <span className="eyebrow">One-time setup</span>
        <h1>Connect the Firebase web app</h1>
        <p>{message}</p>
        <code>cp .env.example .env.local</code>
        <p className="muted">
          The desktop catalog stays local. Firebase only receives account,
          project, and portable clip metadata.
        </p>
      </section>
    </main>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await createUserWithEmailAndPassword(requireAuth(), email, password);
      } else {
        await signInWithEmailAndPassword(requireAuth(), email, password);
      }
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">Local-first footage intelligence</span>
          <h1>Know what you shot before you start cutting.</h1>
          <p>
            Build a dependable clip catalog from source drives without
            uploading the footage itself.
          </p>
        </div>
        <div className="privacy-note">
          <HardDrive size={18} />
          Source paths and poster frames stay on this Mac.
        </div>
      </section>
      <section className="auth-panel">
        <form className="form-card" onSubmit={submit}>
          <span className="eyebrow">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </span>
          <h2>{mode === "login" ? "Sign in to Docubase" : "Start cataloging"}</h2>
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="editor@studio.com"
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <button className="primary-button" disabled={busy} type="submit">
            {busy && <LoaderCircle className="spin" size={17} />}
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
          <button
            className="text-button"
            onClick={() =>
              setMode((current) =>
                current === "login" ? "register" : "login",
              )
            }
            type="button"
          >
            {mode === "login"
              ? "New to Docubase? Create an account"
              : "Already have an account? Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Workspace({ user }: { user: User }) {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selectedProject, setSelectedProject] =
    useState<LocalProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
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
            Cloud-synced project context, paired with media that remains on
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
            <button
              className="project-card"
              key={project.id}
              onClick={() => setSelectedProject(project)}
            >
              <div className="project-card-top">
                <span className="project-monogram">
                  {project.name.slice(0, 2).toUpperCase()}
                </span>
                <ChevronRight size={19} />
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
          <h2>Set the project context</h2>
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

function CatalogScreen({
  project,
  user,
  onBack,
}: {
  project: LocalProject;
  user: User;
  onBack: () => void;
}) {
  const [clips, setClips] = useState<ClipManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [transcriptSummaries, setTranscriptSummaries] = useState<
    Record<string, ClipTranscriptSummary>
  >({});
  const [utterancesByClip, setUtterancesByClip] = useState<
    Record<string, TranscriptUtterance[]>
  >({});
  const [expandedTranscriptIds, setExpandedTranscriptIds] = useState<
    Set<string>
  >(new Set());
  const [loadingTranscriptIds, setLoadingTranscriptIds] = useState<Set<string>>(
    new Set(),
  );
  const [transcriptMatches, setTranscriptMatches] = useState<
    TranscriptSearchMatch[]
  >([]);
  const [transcribingClipId, setTranscribingClipId] = useState<string | null>(
    null,
  );
  const [transcriptionProgress, setTranscriptionProgress] = useState<
    string | null
  >(null);
  const [transcriptionDialogOpen, setTranscriptionDialogOpen] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "error" | "success" | "warning";
    message: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refreshClips = useCallback(async () => {
    setLoading(true);
    try {
      setClips(await listLocalClips(project.id));
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  const refreshTranscriptSummaries = useCallback(async () => {
    try {
      const summaries = await listTranscriptSummaries(project.id);
      setTranscriptSummaries(
        Object.fromEntries(summaries.map((summary) => [summary.clipId, summary])),
      );
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    }
  }, [project.id]);

  useEffect(() => {
    void refreshClips();
    void refreshTranscriptSummaries();
  }, [refreshClips, refreshTranscriptSummaries]);

  useEffect(() => {
    let cleanup: () => void = () => {};
    void onImportProgress(setProgress).then((unlisten) => {
      cleanup = unlisten;
    });
    return () => cleanup();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const normalized = query.trim();
    if (normalized.length < 2) {
      setTranscriptMatches([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      void searchTranscripts(project.id, normalized)
        .then((matches) => {
          if (!cancelled) setTranscriptMatches(matches);
        })
        .catch((error) => {
          if (!cancelled) {
            setNotice({ tone: "error", message: readableError(error) });
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [project.id, query]);

  const visibleClips = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return clips;
    const transcriptClipIds = new Set(
      transcriptMatches.map((match) => match.clipId),
    );
    return clips.filter(
      (clip) =>
        [
          clip.filename,
          clip.videoCodec,
          clip.audioCodec ?? "",
          clip.portableDirectoryHint,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized) || transcriptClipIds.has(clip.id),
    );
  }, [clips, query, transcriptMatches]);

  const totalDuration = clips.reduce(
    (sum, clip) => sum + clip.durationMs,
    0,
  );
  const totalBytes = clips.reduce(
    (sum, clip) => sum + clip.fileSizeBytes,
    0,
  );

  async function importFolder() {
    const folderPath = await chooseFolder();
    if (!folderPath) return;
    setWorking(true);
    setNotice(null);
    try {
      const imported = await scanFolder(project.id, folderPath);
      await syncClipManifests(imported);
      await refreshClips();
      setNotice({
        tone: "success",
        message: `${imported.length} clip${imported.length === 1 ? "" : "s"} cataloged. Only metadata was synced to Firebase.`,
      });
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setWorking(false);
      setProgress(null);
    }
  }

  async function relink() {
    const folderPath = await chooseFolder();
    if (!folderPath) return;
    setWorking(true);
    setNotice(null);
    try {
      const count = await relinkFolder(project.id, folderPath);
      setNotice({
        tone: "success",
        message: `${count} catalog entr${count === 1 ? "y" : "ies"} relinked by content fingerprint.`,
      });
      await refreshClips();
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setWorking(false);
    }
  }

  async function copyTimecode(clip: ClipManifest) {
    const value = clipTimecode(
      0,
      clip.frameRate,
      clip.startTimecodeFrames,
    );
    await navigator.clipboard.writeText(value);
    setCopiedId(clip.id);
    window.setTimeout(() => setCopiedId(null), 1_500);
  }

  async function toggleTranscript(clipId: string) {
    if (expandedTranscriptIds.has(clipId)) {
      setExpandedTranscriptIds((current) => {
        const next = new Set(current);
        next.delete(clipId);
        return next;
      });
      return;
    }

    setExpandedTranscriptIds((current) => new Set(current).add(clipId));
    if (utterancesByClip[clipId]) return;
    setLoadingTranscriptIds((current) => new Set(current).add(clipId));
    try {
      const utterances = await listTranscriptUtterances(project.id, clipId);
      setUtterancesByClip((current) => ({ ...current, [clipId]: utterances }));
    } catch (error) {
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setLoadingTranscriptIds((current) => {
        const next = new Set(current);
        next.delete(clipId);
        return next;
      });
    }
  }

  async function processClipTranscription(clip: ClipManifest) {
    let chunks = await prepareTranscription(project.id, clip.id);
    for (let position = 0; position < chunks.length; position += 1) {
      let chunk = chunks[position];
      if (chunk.stage === "complete") continue;

      let payload;
      let reservationId = chunk.reservationId;
      if (chunk.stage === "syncing") {
        setTranscriptionProgress(
          `${clip.filename}: resuming cloud sync (${position + 1}/${chunks.length})`,
        );
        payload = await transcriptChunkPayload(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
        if (!reservationId) {
          throw new Error(
            "The saved transcript is missing its usage reservation. Retry the clip.",
          );
        }
      } else {
        setTranscriptionProgress(
          `${clip.filename}: extracting audio (${position + 1}/${chunks.length})`,
        );
        chunk = await extractTranscriptionChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
        );
        setTranscriptionProgress(
          `${clip.filename}: reserving ${formatUsd(
            estimateTranscriptionCost(chunk.durationMs),
          )} and requesting a temporary Deepgram token`,
        );
        const grant = await beginTranscriptionChunk({
          projectId: project.id,
          clipId: clip.id,
          chunkIndex: chunk.chunkIndex,
        });
        if (grant.alreadyCompleted) {
          throw new Error(
            "This chunk is complete in the cloud but missing locally. Cloud recovery will be added before multi-device collaboration.",
          );
        }
        if (!grant.accessToken) {
          throw new Error("Firebase did not return a temporary Deepgram token.");
        }
        reservationId = grant.reservationId;
        setTranscriptionProgress(
          `${clip.filename}: transcribing with Nova-3 (${position + 1}/${chunks.length})`,
        );
        payload = await transcribeAudioChunk(
          project.id,
          clip.id,
          chunk.chunkIndex,
          grant.accessToken,
          grant.reservationId,
          grant.estimatedCostUsd,
        );
      }

      setTranscriptionProgress(
        `${clip.filename}: saving the transcript (${position + 1}/${chunks.length})`,
      );
      await syncTranscriptChunk(payload);
      await completeCloudTranscriptionChunk({
        projectId: project.id,
        reservationId,
        requestId: payload.chunk.requestId,
      });
      await completeTranscriptionChunk(
        project.id,
        clip.id,
        chunk.chunkIndex,
      );
      chunks = await listTranscriptionChunks(project.id, clip.id);
    }

    const utterances = await listTranscriptUtterances(project.id, clip.id);
    setUtterancesByClip((current) => ({ ...current, [clip.id]: utterances }));
    await refreshTranscriptSummaries();
  }

  async function startClipTranscription(clip: ClipManifest) {
    setTranscribingClipId(clip.id);
    setNotice(null);
    try {
      await processClipTranscription(clip);
      setExpandedTranscriptIds((current) => new Set(current).add(clip.id));
      setNotice({
        tone: "success",
        message: `Transcript ready for ${clip.filename}. Temporary audio chunks were deleted.`,
      });
    } catch (error) {
      await refreshTranscriptSummaries();
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setTranscribingClipId(null);
      setTranscriptionProgress(null);
    }
  }

  async function transcribeRemainingClips() {
    setTranscriptionDialogOpen(false);
    setNotice(null);
    try {
      for (const clip of remainingTranscribableClips) {
        setTranscribingClipId(clip.id);
        await processClipTranscription(clip);
      }
      setNotice({
        tone: "success",
        message: `${remainingTranscribableClips.length} clip${
          remainingTranscribableClips.length === 1 ? "" : "s"
        } transcribed. Audio derivatives were removed after safe sync.`,
      });
    } catch (error) {
      await refreshTranscriptSummaries();
      setNotice({ tone: "error", message: readableError(error) });
    } finally {
      setTranscribingClipId(null);
      setTranscriptionProgress(null);
    }
  }

  const remainingTranscribableClips = clips.filter(
    (clip) =>
      clip.hasAudio && transcriptSummaries[clip.id]?.stage !== "complete",
  );
  const remainingTranscriptionCost = remainingTranscribableClips.reduce(
    (sum, clip) => {
      const summary = transcriptSummaries[clip.id];
      const remainingRatio =
        summary && summary.totalChunks > 0
          ? Math.max(
              0,
              (summary.totalChunks - summary.completedChunks) /
                summary.totalChunks,
            )
          : 1;
      return sum + estimateTranscriptionCost(clip.durationMs * remainingRatio);
    },
    0,
  );
  const recordedTranscriptionCost = Object.values(transcriptSummaries).reduce(
    (sum, summary) => sum + summary.estimatedCostUsd,
    0,
  );

  return (
    <main className="catalog-shell">
      <header className="catalog-topbar">
        <div className="catalog-title">
          <button
            aria-label="Back to projects"
            className="icon-button"
            onClick={onBack}
          >
            <ArrowLeft size={19} />
          </button>
          <Brand />
          <span className="title-divider" />
          <div>
            <strong>{project.name}</strong>
            <span>{user.email}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="secondary-button compact"
            disabled={
              working ||
              Boolean(transcribingClipId) ||
              !isTauri ||
              remainingTranscribableClips.length === 0
            }
            onClick={() => setTranscriptionDialogOpen(true)}
          >
            <AudioLines size={16} />
            Transcribe footage
          </button>
          <button
            className="secondary-button compact"
            disabled={working || Boolean(transcribingClipId) || !isTauri}
            onClick={() => void relink()}
          >
            <RefreshCw size={16} />
            Relink folder
          </button>
          <button
            className="primary-button compact"
            disabled={working || Boolean(transcribingClipId) || !isTauri}
            onClick={() => void importFolder()}
          >
            {working ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <FolderOpen size={17} />
            )}
            Import folder
          </button>
        </div>
      </header>

      <section className="catalog-summary">
        <div>
          <span className="eyebrow">Local media catalog</span>
          <h1>{project.name}</h1>
          <p>{project.brief || "No production brief yet."}</p>
        </div>
        <div className="metric-row">
          <Metric value={clips.length.toLocaleString()} label="clips" />
          <Metric value={formatDuration(totalDuration)} label="footage" />
          <Metric value={formatBytes(totalBytes)} label="source drives" />
          <Metric
            value={formatUsd(recordedTranscriptionCost)}
            label="transcription"
          />
        </div>
      </section>

      {notice && <Notice tone={notice.tone}>{notice.message}</Notice>}
      {working && progress && (
        <div className="progress-panel">
          <div>
            <LoaderCircle className="spin" size={17} />
            <span>
              Inspecting {progress.currentFilename || "catalog metadata"}
            </span>
          </div>
          <strong>
            {progress.completed} / {progress.total}
          </strong>
          <progress max={Math.max(progress.total, 1)} value={progress.completed} />
        </div>
      )}
      {transcribingClipId && transcriptionProgress && (
        <div className="progress-panel transcription">
          <div>
            <AudioLines className="pulse" size={17} />
            <span>{transcriptionProgress}</span>
          </div>
          <strong>Keep Docubase open</strong>
          <progress />
        </div>
      )}

      <section className="catalog-panel">
        <div className="catalog-toolbar">
          <label className="search-box">
            <Search size={17} />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search clip names, codecs, folders, or spoken words"
              value={query}
            />
          </label>
          <span>
            {visibleClips.length} of {clips.length} clips
          </span>
        </div>

        {loading ? (
          <LoadingBlock label="Reading the local catalog…" />
        ) : clips.length === 0 ? (
          <div className="table-empty">
            <span className="empty-icon">
              <FolderOpen size={25} />
            </span>
            <h2>Attach the first footage folder</h2>
            <p>
              Docubase reads MOV, MP4, M4V, and ProRes-in-MOV files in place.
              No source video is uploaded or copied.
            </p>
            <button
              className="primary-button"
              disabled={!isTauri}
              onClick={() => void importFolder()}
            >
              <FolderOpen size={17} />
              Choose folder
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Clip</th>
                  <th>Duration</th>
                  <th>Video</th>
                  <th>Resolution</th>
                  <th>Source timecode</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Transcript</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleClips.map((clip) => {
                  const source = posterSource(clip.posterPath);
                  const transcriptSummary = transcriptSummaries[clip.id];
                  const transcriptMatch = transcriptMatches.find(
                    (match) => match.clipId === clip.id,
                  );
                  const transcriptOpen = expandedTranscriptIds.has(clip.id);
                  const timecode =
                    clip.startTimecodeFrames === null
                      ? "—"
                      : clipTimecode(
                          0,
                          clip.frameRate,
                          clip.startTimecodeFrames,
                        );
                  return (
                    <Fragment key={clip.id}>
                    <tr>
                      <td>
                        <div className="clip-cell">
                          <div className="poster">
                            {source ? (
                              <img alt="" src={source} />
                            ) : (
                              <Film size={19} />
                            )}
                          </div>
                          <div>
                            <strong title={clip.filename}>
                              {clip.filename}
                            </strong>
                            <span>
                              {clip.portableDirectoryHint || "Footage"}
                            </span>
                            {transcriptMatch && (
                              <span className="spoken-match">
                                “{transcriptMatch.text}”
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{formatDuration(clip.durationMs)}</td>
                      <td>
                        <strong>{clip.videoCodec}</strong>
                        <span className="table-subline">
                          {formatFrameRate(
                            clip.frameRate.numerator,
                            clip.frameRate.denominator,
                          )}{" "}
                          fps
                        </span>
                      </td>
                      <td>
                        {clip.width > 0
                          ? `${clip.width} × ${clip.height}`
                          : "—"}
                      </td>
                      <td>
                        <button
                          className="timecode-button"
                          disabled={timecode === "—"}
                          onClick={() => void copyTimecode(clip)}
                          title="Copy source timecode"
                        >
                          {timecode}
                          {copiedId === clip.id ? (
                            <Check size={14} />
                          ) : (
                            <Clipboard size={14} />
                          )}
                        </button>
                      </td>
                      <td>{formatBytes(clip.fileSizeBytes)}</td>
                      <td>
                        <span
                          className={`status-pill ${clip.stage}`}
                          title={clip.error ?? undefined}
                        >
                          {clip.stage === "failed" && (
                            <TriangleAlert size={12} />
                          )}
                          {clip.stage}
                        </span>
                      </td>
                      <td>
                        <button
                          className={`transcript-toggle ${
                            transcriptSummary?.stage ?? "not_started"
                          }`}
                          disabled={!clip.hasAudio}
                          onClick={() => void toggleTranscript(clip.id)}
                        >
                          <FileText size={13} />
                          {!clip.hasAudio
                            ? "No audio"
                            : transcriptSummary?.stage === "complete"
                              ? `${transcriptSummary.utteranceCount} lines`
                              : transcriptSummary?.stage === "failed"
                                ? "Retry"
                                : transcriptSummary?.stage === "not_started" ||
                                    !transcriptSummary
                                  ? "Not started"
                                  : transcriptSummary.stage}
                          {transcriptOpen ? (
                            <ChevronUp size={13} />
                          ) : (
                            <ChevronDown size={13} />
                          )}
                        </button>
                      </td>
                      <td>
                        <button
                          className="row-action"
                          onClick={() =>
                            void revealClip(project.id, clip.id).catch(
                              (error) =>
                                setNotice({
                                  tone: "error",
                                  message: readableError(error),
                                }),
                            )
                          }
                        >
                          Reveal
                        </button>
                      </td>
                    </tr>
                    {transcriptOpen && (
                      <tr className="transcript-row">
                        <td colSpan={9}>
                          <TranscriptPanel
                            clip={clip}
                            loading={loadingTranscriptIds.has(clip.id)}
                            onTranscribe={() => void startClipTranscription(clip)}
                            query={query}
                            summary={transcriptSummary}
                            transcribing={transcribingClipId === clip.id}
                            utterances={utterancesByClip[clip.id] ?? []}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {transcriptionDialogOpen && (
        <TranscriptionDialog
          clipCount={remainingTranscribableClips.length}
          durationMs={remainingTranscribableClips.reduce(
            (sum, clip) => sum + clip.durationMs,
            0,
          )}
          estimatedCostUsd={remainingTranscriptionCost}
          onCancel={() => setTranscriptionDialogOpen(false)}
          onConfirm={() => void transcribeRemainingClips()}
        />
      )}
    </main>
  );
}

function TranscriptPanel({
  clip,
  summary,
  utterances,
  loading,
  transcribing,
  query,
  onTranscribe,
}: {
  clip: ClipManifest;
  summary: ClipTranscriptSummary | undefined;
  utterances: TranscriptUtterance[];
  loading: boolean;
  transcribing: boolean;
  query: string;
  onTranscribe: () => void;
}) {
  const estimatedCost = estimateTranscriptionCost(clip.durationMs);
  return (
    <div className="transcript-panel">
      <div className="transcript-heading">
        <div>
          <span className="eyebrow">Timestamped dialogue</span>
          <h3>{clip.filename}</h3>
          <p>
            Nova-3 English, smart formatting, word timestamps, and speaker
            diarization. Estimated maximum: {formatUsd(estimatedCost)}.
          </p>
        </div>
        {clip.hasAudio && summary?.stage !== "complete" && (
          <button
            className="primary-button compact"
            disabled={transcribing}
            onClick={onTranscribe}
          >
            {transcribing ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <AudioLines size={16} />
            )}
            {summary?.stage === "failed" ? "Retry transcript" : "Transcribe clip"}
          </button>
        )}
      </div>
      {summary?.error && <Notice tone="error">{summary.error}</Notice>}
      {loading ? (
        <LoadingBlock label="Reading the local transcript…" />
      ) : summary?.stage === "complete" && utterances.length === 0 ? (
        <div className="transcript-empty">
          No speech was detected in this clip.
        </div>
      ) : utterances.length === 0 ? (
        <div className="transcript-empty">
          Transcribe this clip to search and review its spoken content.
        </div>
      ) : (
        <div className="utterance-list">
          {utterances.map((utterance) => (
            <div
              className={`utterance ${
                query.trim() &&
                utterance.text
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase())
                  ? "match"
                  : ""
              }`}
              key={utterance.id}
            >
              <div className="utterance-meta">
                <strong>
                  {utterance.speaker === null
                    ? "Speaker"
                    : `Speaker ${utterance.speaker + 1}`}
                </strong>
                <span>
                  {clipTimecode(
                    utterance.startMs,
                    clip.frameRate,
                    clip.startTimecodeFrames,
                  )}
                </span>
              </div>
              <p>{utterance.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptionDialog({
  clipCount,
  durationMs,
  estimatedCostUsd,
  onCancel,
  onConfirm,
}: {
  clipCount: number;
  durationMs: number;
  estimatedCostUsd: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-label="Confirm transcription"
        className="modal-card transcription-dialog"
      >
        <div>
          <span className="eyebrow">Cost-controlled transcription</span>
          <h2>Transcribe remaining footage?</h2>
          <p>
            Docubase will process {clipCount} clip{clipCount === 1 ? "" : "s"} (
            {formatDuration(durationMs)}) sequentially.
          </p>
        </div>
        <div className="cost-callout">
          <div>
            <span>Estimated provider cost</span>
            <strong>{formatUsd(estimatedCostUsd)}</strong>
          </div>
          <p>
            Audio is converted locally to temporary 48 kbps mono chunks, sent
            directly to Deepgram, and deleted after the transcript is safely
            stored. Original video is never uploaded.
          </p>
        </div>
        <div className="provider-settings">
          <span>Model</span>
          <strong>Nova-3 English</strong>
          <span>Chunk size</span>
          <strong>30 minutes</strong>
          <span>Diarization</span>
          <strong>Latest batch model</strong>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" onClick={onConfirm} type="button">
            <AudioLines size={17} />
            Start transcription
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Film size={19} />
      </span>
      <strong>Docubase</strong>
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "error" | "success" | "warning";
}) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <main className="centered-shell">
      <LoadingBlock label={label} />
    </main>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="loading-block">
      <LoaderCircle className="spin" size={21} />
      <span>{label}</span>
    </div>
  );
}

function splitTerms(value: string): string[] {
  return value
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 2 : 2,
    maximumFractionDigits: value < 0.01 ? 3 : 2,
  }).format(value);
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please try again.";
}
