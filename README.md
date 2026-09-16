# Docubase

> **Work in progress.** Docubase is an experimental macOS app and is not ready
> for production use or general distribution.

Docubase helps documentary editors understand and search large collections of
footage. Original video stays on the editor's drives. The app builds a local
catalog, transcribes speech on-device with Apple Speech, analyzes selected
low-resolution frames and transcripts with Gemini, and creates a grounded
semantic search index.

## Current capabilities

- In-place MOV, MP4, M4V, and ProRes cataloging
- Local Apple Speech transcription with timestamps
- Evidence-backed clip descriptions, tags, and visual moments
- Batch or fast Gemini analysis with cost estimates and progress
- Semantic search across visual and spoken evidence
- Local project thumbnails and contextual plain-text resources

## Stack

React and TypeScript power the interface, Rust owns local persistence and Tauri
commands, Swift/AVFoundation handles media, and Firebase hosts authentication,
portable metadata, protected thumbnails, Cloud Functions, and vector search.

## Development

Requires macOS 26+, Swift 6.2+, Rust 1.85+, and Node 24.

```sh
cp .env.example .env.local
npm install
npm --prefix functions install
npm run tauri:dev
```

Firebase and Gemini setup is required for cloud analysis and semantic search.
Never commit `.env.local` or provider credentials.

Useful checks:

```sh
npm run build
npm test
npm --prefix functions test
npm run test:rust
npm run test:swift
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the code map,
[ANALYSIS_PIPELINE_SPEC.md](./ANALYSIS_PIPELINE_SPEC.md) for the analysis
pipeline, and [PLAN.md](./PLAN.md) for current status and next milestones.

No open-source license has been selected yet.
