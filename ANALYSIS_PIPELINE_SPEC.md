# Analysis pipeline

Status: implemented; real-footage calibration is ongoing.

## Purpose

Docubase combines two independent evidence sources:

- The complete timestamped transcript explains what is said.
- Timestamped frames explain only what is visible.

The pipeline keeps those sources separate until a deterministic clip-level
merge. This prevents a screenshot from being treated as proof of a spoken
topic, or a transcript from being treated as proof of a visible detail.

Project background from attached plain-text resources may clarify vocabulary,
names, organizations, and subject matter. It is explicitly labeled as context,
not evidence that a claim occurs in a particular clip.

## Pipeline

### 1. Local preparation

Apple media frameworks inspect source files, extract temporary audio, and
sample low-resolution frames. The app rejects near-duplicate frames, records
exact timestamps, and calculates non-biometric pixel-change metrics.

Source video stays in place. Temporary audio and unapproved frames stay local.

### 2. Complete transcript analysis

Transcript utterances are ordered chronologically and sent with their evidence
identifiers. If a transcript exceeds request limits, it is divided at utterance
boundaries into deterministic contiguous sections. Every section is analyzed,
then synthesized; this is a size fallback, not relevance sampling.

Transcript output includes a concise summary, speech format, subjects,
keywords, named entities, confidence, and cited utterance identifiers.

### 3. Visual routing

One representative midpoint frame is analyzed without transcript text. The
routing decision combines:

1. Transcript format and confidence
2. Visible composition and confidence
3. Local visual-stability metrics

Only a confidently interview-like and visually stable clip takes the
single-image route. Any uncertainty takes the full visual route.

### 4. Visual analysis

Stable interviews use the already analyzed routing frame and upload no extra
images. Changing or uncertain clips use chronological visual moments containing
one or more retained frames.

Visual prompts contain frame identifiers, timestamps, and project vocabulary,
but no transcript excerpts. Output includes a concrete description, accurate
visual keywords, facets, confidence, and cited frame identifiers.

### 5. Deterministic merge

The final clip description:

1. Leads with substantive transcript subject matter when available.
2. Identifies the footage or speech format when useful.
3. Adds one concise sentence of grounded visual context.
4. Falls back to a single evidence source when the other is unavailable.
5. Remains at most two sentences and 70 words.

Keywords merge transcript and visual terms, remove duplicates and weak generic
labels, and preserve evidence provenance. Editor changes are never overwritten
by a later refresh.

## Processing modes

- **Batch** is the default and cheapest mode. Work may complete later.
- **Fast** uses standard Gemini requests and costs more, but normally completes
  while the app remains open.

Both modes use the same schemas and validation. The app shows estimated cost,
reserved cost, recorded cost, and measurable stage progress.

## Project-wide runs

One confirmation creates a durable SQLite queue containing every currently
eligible clip and the full-run cost estimate. Docubase submits up to three
clips concurrently, retries transient network, quota, timeout, and 5xx errors
with exponential backoff, and continues when an individual clip fails.

Queued, retrying, submitted, complete, failed, and skipped states are persisted
per clip. Reopening the project resumes unfinished submissions and result
collection. Cloud results are refreshed in bounded groups so very large
projects do not create an unbounded polling burst. The run finishes only when
every queued clip reaches a terminal state; failed clips can then be retried in
a new idempotent run.

## Reliability

- Every job has a versioned evidence fingerprint.
- Submission and result collection are idempotent.
- Each provider job is checkpointed before the next stage begins.
- Failed siblings do not discard successful batch results.
- Every returned evidence identifier is checked against supplied input.
- Existing paid work is collected rather than silently resubmitted.
- Temporary submission failures do not stop sibling clips.
- Run progress and cost estimates cover the entire queued project selection.
- Budget reservations are reconciled against observed token usage.

## Out of scope

- Face recognition or face clustering
- Voice identity across clips
- Project-wide generated story context
- Inferring names, locations, relationships, or intent without evidence
- Uploading source video or retaining audio in Firebase
