# Docubase architecture

Docubase uses four focused layers:

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Interface | React, TypeScript, CSS | Screens, validation, and workflow orchestration |
| Desktop backend | Rust and Tauri | SQLite, local files, durable jobs, and native commands |
| Media worker | Swift and AVFoundation | Metadata, timecode, frames, audio, and Apple Speech |
| Cloud backend | Firebase Functions and TypeScript | Authorization, Gemini work, budgets, and search |

## Reading order

1. `src/lib/contracts.ts` — shared frontend contracts
2. `src/App.tsx` — authentication and top-level navigation
3. `src/features/projects/Workspace.tsx` — project list and settings
4. `src/features/catalog/CatalogScreen.tsx` — project catalog
5. `src/features/catalog/useTranscriptionWorkflow.ts` — local transcription
6. `src/features/catalog/useVisualWorkflow.ts` — frame and analysis pipeline
7. `src/features/catalog/useSemanticSearch.ts` — search indexing and queries
8. `src/lib/native.ts` and `src/lib/cloud.ts` — native/cloud boundaries
9. `src-tauri/src/lib.rs` — registered native commands
10. `functions/src/index.ts` — deployed cloud entry points

## Repository map

### `src/`

- `components/` contains shared UI components.
- `features/auth/` contains sign-in and configuration screens.
- `features/projects/` contains project creation, editing, and deletion.
- `features/catalog/` owns the clip catalog and workflow hooks.
- `features/transcription/` renders transcript evidence.
- `features/visual/` renders frames, moments, and analysis controls.
- `lib/contracts.ts` is the TypeScript data vocabulary.
- `lib/native.ts` is the only frontend wrapper around Tauri commands.
- `lib/cloud.ts` is the frontend boundary to Firestore and callables.
- `styles/` mirrors the feature split.

### `src-tauri/src/`

- `lib.rs` initializes app state and registers commands.
- `database.rs` owns schema creation and additive migrations.
- `models.rs` contains serialized native contracts.
- `projects.rs` stores projects and local project assets.
- `catalog.rs` scans, fingerprints, relinks, and lists footage.
- `transcription.rs` advances transcription work.
- `transcription/repository.rs` persists transcript state.
- `visual.rs` selects and stores local visual evidence.
- `analysis_queue.rs` persists resumable project-wide analysis runs.
- `media.rs` launches the bundled Swift sidecar.
- `utilities.rs` contains small shared helpers.

Rust is the source of truth for local durability. A refresh should reconstruct
the interface from SQLite instead of relying on an in-memory task.

### `native/MediaWorker/`

- `main.swift` implements the sidecar JSON protocol.
- `MediaModels.swift` contains worker requests and responses.
- `MediaInspector.swift` reads media metadata and extracts audio.
- `AppleSpeechTranscriber.swift` performs on-device transcription.
- `FrameExtractor.swift` selects and writes visual evidence.
- `TimecodeReader.swift` reads embedded camera timecode.

Swift is intentionally narrow: it provides direct access to Apple media and
speech frameworks while the rest of the application remains platform-neutral.

### `functions/src/`

- `index.ts` exports callable endpoints.
- `shared.ts` configures Firebase and validates common inputs.
- `projects.ts` accepts protected frames and deletes project data.
- `visual/submit.ts` starts analysis work.
- `visual/refresh.ts` and `visual/separated-refresh.ts` collect results.
- `visual/requests.ts` builds Gemini requests and schemas.
- `visual/validation.ts` validates untrusted model output.
- `usage.ts` reserves and reconciles provider cost.
- `semantic-search.ts` builds and queries the vector index.
- Pure helpers have focused tests in `functions/test/`.

## Main workflows

### Import

1. React asks Rust to scan a folder.
2. Rust fingerprints each supported file and asks Swift for metadata.
3. Swift returns metadata and a local poster frame.
4. Rust writes SQLite records.
5. The frontend syncs portable metadata without local paths.

### Transcription

1. Rust creates deterministic 30-minute jobs.
2. Swift extracts one temporary AAC chunk.
3. Apple Speech transcribes the chunk on the Mac.
4. Rust stores normalized utterances and words.
5. The frontend syncs transcript evidence.
6. Rust deletes the temporary audio after completion.

### Analysis

1. Swift selects low-resolution frames locally.
2. The editor reviews derivative size and estimated cost.
3. Rust saves every eligible clip in a durable project-wide queue.
4. The frontend submits a bounded number concurrently and retries transient
   failures without stopping sibling clips.
5. The complete transcript and visual evidence are analyzed independently.
6. Stable interviews stop after one image; other clips use visual moments.
7. Cloud code validates evidence identifiers and merges the two sources.
8. The frontend displays descriptions, tags, provenance, cost, and queue-wide
   progress, resuming the run after an app restart when necessary.

### Semantic search

1. The editor explicitly builds an index in batch or fast mode.
2. Cloud code creates records for clips, visual moments, and transcript passages.
3. Gemini creates 768-dimensional embeddings.
4. Firestore Enterprise stores and searches protected vectors.
5. Results return stored descriptions, quotes, frames, and timestamps.

## Invariants

- Original video is never uploaded or copied into Docubase storage.
- Absolute paths, local thumbnails, and original context files never enter
  Firestore. Only the bounded background text used by analysis is synced.
- Temporary audio is deleted after durable completion.
- Cross-layer times are integer milliseconds unless named otherwise.
- Model output is untrusted and must cite supplied evidence identifiers.
- User-edited descriptions and tags take precedence over generated values.
- Paid work is idempotent and resumable; refresh must not duplicate requests.
- Search results are grounded in indexed evidence, not newly generated prose.

## Cross-layer changes

When a serialized field changes, update the owning Zod schema, matching Rust
model, Swift `Codable` model when applicable, cloud contract, persistence
schema, security rules, and the lowest useful test.

## Verification

```sh
npm run build
npm test
npm --prefix functions test
npm run test:rules
npm run test:rust
npm run test:swift
npm run tauri:build
```
