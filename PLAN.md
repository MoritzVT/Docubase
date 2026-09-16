# Docubase plan

## Product direction

Docubase is a local-first documentary footage catalog and search tool for
macOS. It should help an editor answer questions such as “where is the cyclist
approaching the mountain?” or “where does John discuss climate fundraising?”
without uploading any media.

The priorities are:

1. Keep source video, absolute paths, temporary audio, and private project
   attachments local.
2. Return search results grounded in stored frames, transcript excerpts, and
   precise timestamps.
3. Prefer low cloud cost over fast completion, while offering an explicit fast
   mode when needed.
4. Make long-running work measurable, resumable, and safe to retry.
5. Keep the code approachable enough for one developer to understand.

## Current implementation

### Local catalog

- Tauri desktop shell with a React interface and local SQLite database.
- Recursive in-place import of supported camera media.
- Sampled fingerprints, metadata, poster frames, embedded source timecode,
  chronological sorting, relinking, and Reveal in Finder.
- Editable project metadata, optional project thumbnails, and local text
  attachments.

### Transcription

- AVFoundation extracts deterministic 30-minute audio chunks.
- Apple SpeechAnalyzer transcribes on-device with project vocabulary.
- Timestamped utterances are saved locally and synced as portable evidence.
- Temporary audio is deleted after durable completion.

### Visual and clip analysis

- AVFoundation selects small, timestamped JPEG frames locally.
- Gemini receives only approved derivatives and complete transcript evidence.
- Transcript and visual analysis remain separate until a deterministic merge.
- A confidently stable interview uses one image; changing footage uses the
  retained visual sequence.
- Batch is the default economy mode. Fast mode uses standard requests.
- Progress and estimated/recorded cost are visible in the app.

### Search

- Gemini Embedding 2 indexes clip summaries, visual moments, and transcript
  passages.
- Firestore Enterprise performs cosine vector search.
- Search results display existing evidence rather than generated answers.
- Indexing supports batch and fast modes with cost estimates and progress.

## Data boundary

Local only:

- Original video and absolute source paths
- SQLite catalog and processing state
- Poster frames and unapproved visual frames
- Temporary audio
- Custom project thumbnails and original contextual text files

Cloud:

- Authentication and project membership
- Portable clip metadata
- Completed transcripts
- Approved low-resolution frames
- Generated descriptions, tags, usage records, and search vectors
- A bounded excerpt from contextual text files, explicitly labeled as
  background rather than clip evidence

Context files help analysis resolve names, terminology, organizations, and the
project's subject. Their original files stay local; Docubase syncs at most
12,000 UTF-8 characters of labeled background text and includes that limit in
the cost estimate.

## Next milestones

### Quality calibration

- Evaluate search relevance against real documentary queries.
- Tune interview routing and visual-change thresholds using varied footage.
- Improve summaries and tags based on editor corrections.
- Add regression fixtures for difficult transcripts and visual sequences.

### Scale and reliability

- Validate multi-terabyte projects and interrupted external-drive workflows.
- Add clearer recovery for partial Firebase and Gemini failures.
- Measure index size, cloud cost, and query latency on a large project.
- Add quotas, alerts, and operational logging.

### Collaboration and distribution

- Add editor/viewer roles and invitations.
- Add App Check and a deployment runbook.
- Produce signed, notarized, universal macOS builds.
- Define a stable migration policy for local SQLite and cloud documents.

## Explicitly deferred

- Face recognition or face clustering
- Voice identity across clips
- Source-video upload or cloud playback proxies
- Windows and browser versions
- Premiere, Resolve, or Final Cut integration
