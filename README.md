# Docubase

Docubase is a local-first macOS catalog and transcript finder for documentary
footage. It indexes camera files in place, extracts portable metadata and local
poster frames, and can send temporary compressed audio directly to Deepgram for
transcription. Source video, absolute paths, poster files, and audio are never
stored in Firebase.

The complete product plan and iterative goals are in [PLAN.md](./PLAN.md).

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
`.env.local`. Set it once from a private terminal prompt:

```sh
npx firebase functions:secrets:set DEEPGRAM_API_KEY \
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

Only portable clip metadata and completed transcript data are synced. The
Firestore rules reject common local-path and audio-path field names, require
`posterPath` to be null, and prevent clients from writing server-owned usage
accounting.

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
