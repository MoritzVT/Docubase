# Docubase

Docubase is a local-first macOS catalog, transcript finder, and visual index for
documentary footage. It indexes camera files in place, sends temporary
compressed audio directly to Deepgram, and uses Gemini Batch only for
editor-approved retained thumbnails and complete timestamped transcripts. The
two evidence sources are analyzed independently before a deterministic merge. Source
video, absolute paths, poster files, and audio are never stored in Firebase.

The complete product plan and iterative goals are in [PLAN.md](./PLAN.md).
For a guided tour of the languages, modules, and end-to-end workflows, read
[ARCHITECTURE.md](./ARCHITECTURE.md).
The next analysis-quality refinement is specified in
[ANALYSIS_PIPELINE_SPEC.md](./ANALYSIS_PIPELINE_SPEC.md).

## Goal 1 features

- Tauri 2 desktop shell with React and TypeScript.
- Swift AVFoundation media worker for MOV/MP4/M4V/ProRes inspection.
- SQLite catalog under the macOS application-data directory.
- Fast sampled fingerprints for duplicate detection and relinking.
- Rational and drop-frame-aware source timecode.
- Firebase email/password authentication and project metadata sync.
- Membership-protected Firestore rules with emulator tests.
- Reveal in Finder, Copy Timecode, folder filtering, and relinking.

## Goal 2 features

- Resumable local extraction of 30-minute, 16 kHz mono AAC chunks.
- Direct transcription with Deepgram Nova-3, utterance and word timestamps,
  smart formatting, and speaker diarization.
- Short-lived Deepgram credentials minted by an authenticated Firebase
  callable; the permanent provider key never reaches the desktop app.
- Server-side membership, duration, budget, and usage validation before each
  provider request.
- Idempotent cost reservations and usage events at an estimated $0.0068 per
  footage minute ($0.408 per hour).
- Local SQLite transcript storage plus member-protected transcript sync to
  Firestore.
- Expandable transcript rows, speaker labels, timecodes, highlighted spoken-word
  search, per-clip retry, and a preflight cost confirmation.
- Interruption recovery that reuses an extracted chunk or resumes its Firestore
  sync without repeating already completed chunks.
- Automatic deletion of each temporary audio chunk after its transcript and
  usage record have both been committed.

## Goal 3 and 3.1 features

- Free local sampling at roughly one frame per second with adaptive
  change-selection, near-duplicate rejection, and a hard maximum of 12 retained
  frames per footage minute.
- Orientation-correct JPEG evidence at no more than 384 px or 100 KB, grouped
  into deterministic 15-second moments and stored with precise source
  timestamps.
- A preflight showing retained frame count, retained bytes, moment count, and
  a mode-specific Gemini cost estimate before anything is uploaded. Batch is
  the default; optional Fast mode uses Standard requests at roughly twice the
  model cost.
- Authenticated upload callables that validate membership against the named
  Firestore database, accept only retained JPEGs up to 100 KB, and keep direct
  client access to the Storage bucket disabled.
- `gemini-3.5-flash-lite` Batch analysis with minimal thinking and strict JSON
  output for separate transcript meaning, visual routing, and visual facets.
- Complete transcripts are analyzed chronologically. Oversized transcripts are
  split only at utterance boundaries, with every section analyzed and then
  synthesized; no beginning/middle/end relevance sampling is used.
- Visual-moment requests contain frames and frame IDs only—never transcript
  excerpts, spoken topics, or utterance IDs.
- A conservative three-signal router combines transcript format, one midpoint
  frame, and local pixel-change metrics. A confidently stable interview sends
  exactly one image to Gemini and leaves every other retained frame local.
  Changing, mixed, or uncertain clips upload and analyze the adaptive sequence.
- Clip descriptions and keywords are merged deterministically, with transcript
  subject matter first, concise visual context second, and stored source
  provenance. Descriptions are capped at two sentences and 70 words.
- Server-side evidence validation: generated frame and utterance references
  must resolve to IDs supplied for that moment.
- Browsable frame strips and moment cards with source timecodes, editable
  descriptions/tags, category filtering, and clip-level visual summaries.
- Resumable local/cloud stages, versioned deterministic retry chains,
  duplicate-submission protection, atomic cost reservations, preservation of
  editor changes, and reconciliation against all observed Batch token usage.
- No face detection, face embeddings, or face clustering.

## Prerequisites

- macOS 13 or newer.
- Xcode Command Line Tools.
- Swift 6 or newer.
- Rust stable.
- Node 24 for local tooling. Cloud Functions deploy on Node 22, the latest
  Firebase-supported runtime selected in `firebase.json`.
- Java 21 or newer for the Firestore emulator.

This checkout pins the local Node version in `.node-version`. On this Mac the
Homebrew runtime can be selected with:

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"
```

## Firebase setup

The Firebase project is `docubase-455a4`. Copy `.env.example` to `.env.local`
and fill it with the Firebase web-app SDK values. Enable Email/Password in
Firebase Authentication.

The Deepgram permanent API key belongs in Google Secret Manager, not
`.env.local`. The key must use Deepgram's **Member** role or higher because
temporary token grants are not available to narrower keys. Set it once from a
private terminal prompt:

```sh
npx firebase functions:secrets:set DEEPGRAM_API_KEY \
  --project docubase-455a4
```

Goal 3 also requires the one-time Firebase Storage setup. In the
[Firebase Storage console](https://console.firebase.google.com/project/docubase-455a4/storage),
click **Get started** and create the default bucket. Prefer `us-central1` when
offered: it is the same location as the thumbnail-processing functions and is
the cheap-first choice for this validation project.

Create a Gemini Developer API key in
[Google AI Studio](https://aistudio.google.com/app/apikey), then save it from a
private terminal prompt. Do not put it in `.env.local` or paste it into chat:

```sh
npx firebase functions:secrets:set GEMINI_API_KEY \
  --project docubase-455a4
```

Then deploy:

```sh
npm run firebase:login
npm run firebase:deploy
```

The existing Firestore Enterprise database ID is `default` (without
parentheses) in `nam5`; both the client and deploy configuration explicitly
target that named database.

Only portable clip metadata, completed transcript data, approved retained
JPEGs, and evidence-backed analysis records are synced. Firestore rules reject
local/audio paths and protect generated evidence and usage accounting. The
Storage bucket rejects all direct client access; authenticated functions
validate and store approved frames with the Admin SDK.

## Run

```sh
npm install
npm --prefix functions install
npm run tauri:dev
```

`tauri:dev` builds and bundles the native media worker before starting the app.
Use **New project**, then **Import folder**. Import reads files where they are;
it does not copy or upload them. Use **Transcribe footage** to review the
remaining duration and estimated cost before any paid request. The desktop app
must remain open while it extracts and uploads local audio.

Use **1. Transcribe footage** and **2. Generate clip images** to prepare the two
evidence sources independently. Image generation is free and local. Once both
sources exist, **3. Analyze clips** shows the exact derivative size and
estimated cost. Batch remains the cheap default; select **Fast mode** to use
standard Gemini requests when turnaround matters more than the roughly 2× API
price. Docubase analyzes the complete transcript and selected
images separately, then merges them into one concise description and tag set.
A stable interview uses only its one routing image.

Gemini Batch is asynchronous and may take hours. A stage-based progress bar
shows how far each active job has moved through Docubase's pipeline and checks
for updates automatically (more frequently for Fast mode). The desktop may be
closed after Batch submission; reopening it resumes status checks without
repeating completed paid work.

The catalog date column can use embedded **Recorded** metadata, the **Date
added** to Docubase, or the source file's **File modified** timestamp. Select a
date source, then use the arrow to switch between oldest-first and newest-first.
Clips missing the selected date remain at the end.

Project owners can delete a project from its card. Deletion requires typing the
exact project name, attempts to cancel active Gemini Batch jobs, removes cloud
records and retained thumbnails, and clears the local index/cache without ever
touching original footage.

## Transcription data flow

1. The app divides an audio-bearing clip into deterministic 30-minute jobs in
   local SQLite.
2. AVFoundation writes one 16 kHz mono AAC `.m4a` chunk to the application cache.
3. An authenticated callable validates membership, expected duration, and the
   project's per-hour budget, then atomically reserves the estimated cost and
   returns a five-minute Deepgram token.
4. The desktop process uploads the temporary chunk directly to Deepgram. Original
   video never enters the request or Firebase.
5. Normalized utterances and words are saved locally, synced to Firestore, and
   the reserved usage is finalized.
6. The local `.m4a` is deleted. If the app stops earlier, the job resumes from
   its last durable stage.

A provider request that succeeds immediately before an unexpected process or
machine failure is the one unavoidable retry boundary: because the provider has
already received the audio but the local response may not yet be durable, that
single chunk can require a paid retry.

## Visual data flow and cost

1. AVFoundation samples locally and retains only useful 384 px frames. SQLite
   stores their exact timestamps and resumable state.
2. The editor reviews a conservative preflight. No network request occurs until
   they approve it.
3. The desktop uploads one representative midpoint frame through an
   authenticated callable. The callable validates membership, metadata, JPEG
   bytes, and its exact object path before storing it.
4. One Batch stage analyzes the complete transcript independently and classifies
   only the visible composition of that routing frame.
5. Stable interviews stop after that one image. For any changing or uncertain
   clip, Refresh uploads the remaining retained frames and submits visual-only
   15-second moment requests in groups of 100.
6. Refresh validates source-specific evidence IDs, deterministically merges the
   transcript and visual records, and reconciles observed token usage.

The preflight reserves a conservative worst case that includes the complete
transcript path, routing request, and full retained-frame sequence. Stable
interviews use less than that estimate because they stop at one Gemini image.
The server rejects work above the project’s configured visual allowance and
reconciles the reservation against observed provider usage when processing
ends. The allowance considers both footage duration and clip count: each clip
adds fixed transcript/routing overhead, while footage minutes add visual-moment
headroom. A $0.02 floor prevents small projects from being under-budgeted by
fixed requests. This is a safety ceiling, not money that Docubase spends
automatically.

## Verify

```sh
npm run test
npm run test:rules
npm run build
npm run test:rust
npm run test:swift
npm --prefix functions run build
npm run tauri:build
```

The macOS `.app` and `.dmg` are written below
`src-tauri/target/release/bundle/`. Development builds are unsigned; signing
and notarization are part of Goal 5.
