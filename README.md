# Docubase

Docubase is a local-first macOS catalog for documentary footage. Goal 1 indexes
camera files in place, extracts portable metadata and a local poster frame, and
syncs only safe project/clip records to Firebase. Source video, absolute paths,
and poster files are never uploaded.

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
Firebase Authentication, then deploy:

```sh
npm run firebase:login
npm run firebase:deploy
```

The existing Firestore Enterprise database ID is `default` (without
parentheses) in `nam5`; both the client and deploy configuration explicitly
target that named database.

Only these fields are synced for a clip: filename, fingerprint, portable parent
folder hint, media metadata, processing state, and timestamps. The Firestore
rules reject common local-path field names and require `posterPath` to be null.

## Run

```sh
npm install
npm --prefix functions install
npm run tauri:dev
```

`tauri:dev` builds and bundles the native media worker before starting the app.
Use **New project**, then **Import folder**. Import reads files where they are;
it does not copy or upload them.

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
