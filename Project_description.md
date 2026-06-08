# Nimiq Radio Web App — Implementation Brief

Build a web app where users listen to a shared radio stream/queue. Users can submit songs by paying NIM, and can increase their song’s queue priority by paying more than other queued songs.

## Product Concept

The app is a Nimiq-powered radio system built as a Nimiq Mini App.

Users can:

1. Open the web app and listen to the currently playing song.
2. See the currently playing song metadata:

   * Song title
   * Artist / author
   * Album, if available
   * Nimiq address that submitted it
   * Amount of NIM paid
3. View the upcoming song queue.
4. Submit a new song by providing a song URL from youtube and paying NIM.
5. Move their song higher in the queue by paying more NIM than other users paid.
6. Open song details from the queue to see:

   * Title
   * Artist / author
   * Album
   * Source URL
   * Submitter Nimiq address
   * Amount paid
   * Queue position

## Technical Overview

The web app has:

* A frontend web client.
* A backend server.
* Temporary server-hosted MP3 files.
* A queue system ordered by paid NIM amount.
* Integration to Nimiq via Mini App.
* A background worker that downloads and prepares submitted songs.

The server should download the submitted song, convert/extract it to MP3 if needed, temporarily host the MP3 file, and return a playable URL to the frontend.

Files should be temporary and automatically deleted after a configurable time or after playback is complete.

## Phase 1 — Technical Test / MVP

Goal: prove the core media pipeline works before adding Nimiq payments.

Build a minimal prototype with:

### Frontend

A simple page with:

* An input field where the user enters a YouTube song URL.
* A “Download / Prepare Song” button.
* A loading state while the server processes the URL.
* An audio player that plays the returned MP3 URL.
* A visible link to the generated MP3 file.

### Backend

Create an API endpoint:

`POST /api/prepare-song`

Request body:

```json
{
  "url": "https://www.youtube.com/watch?v=..."
}
```

The backend should:

1. Validate that the URL is allowed.
2. Download the audio from the URL on the server.
3. Convert or extract it as MP3.
4. Save it in temporary storage, for example `/tmp/radio-tracks`.
5. Expose it through a public temporary URL, for example:
6. The backend will be based in a docker container

```txt
/static/tracks/generated-file-id.mp3
```

6. Return JSON:

```json
{
  "success": true,
  "trackUrl": "/static/tracks/generated-file-id.mp3",
  "title": "Song title if available",
  "author": "Artist/channel if available",
  "duration": 213
}
```

Use a tool such as `yt-dlp` plus `ffmpeg` for the first prototype. Find the best option and recommend it.

Important: keep the implementation modular so that later phases can replace YouTube input with other supported sources or stricter validation.

### Phase 1 Acceptance Criteria

* User can paste a YouTube URL.
* Server downloads/extracts the audio.
* Server returns a playable MP3 URL.
* The frontend audio player can play the generated MP3.
* The MP3 file is served from the backend.
* The code is organized so queue/payment logic can be added later.

## Phase 2 — Basic Radio Queue

Add a queue system without payments yet.

Features:

* Submit a song URL.
* Server prepares the MP3.
* Add the song to a queue.
* Display:

  * Currently playing song.
  * Upcoming queue.
  * Song details.
* Automatically move to the next song when the current one ends.
* Queue item model:

```ts
type QueueItem = {
  id: string;
  sourceUrl: string;
  trackUrl: string;
  title: string;
  author?: string;
  album?: string;
  duration?: number;
  submittedBy?: string;
  amountPaid: number;
  createdAt: string;
  status: "pending" | "ready" | "playing" | "played" | "failed";
};
```

## Phase 3 — Nimiq Payment Integration

Add Nimiq payments.

User flow:

1. User enters a song URL.
2. App shows required minimum payment.
3. User's wallet is connected via mini apps framework.
4. User pays NIM to the app’s receiving address.
5. Backend verifies the payment.
6. Song is added to the queue with:

   * Sender Nimiq address
   * Amount paid
   * Transaction hash
   * Song metadata

Payment data model:

```ts
type PaymentInfo = {
  txHash: string;
  senderAddress: string;
  recipientAddress: string;
  amountLuna: number;
  confirmedAt?: string;
};
```

The backend must not trust the frontend for payment amount or sender address. It must verify the transaction via mini apps framework.

## Phase 4 — Paid Queue Priority

Order queued songs by amount paid.

Rules:

* Higher paid songs appear higher in the queue.
* A user can boost an existing queued song by paying more NIM.
* Boosting should update the song’s total paid amount.
* Queue order should update in real time.

Example:

```txt
Song A paid 10 NIM
Song B paid 5 NIM
Song C paid 15 NIM

Queue order:
1. Song C
2. Song A
3. Song B
```

If Song B receives an additional 20 NIM, its total becomes 25 NIM and it moves to the top.

## Phase 5 — Real-Time Updates

Add real-time synchronization using WebSockets or Server-Sent Events.

Frontend should update automatically when:

* Current song changes.
* New song is added.
* Song is boosted.
* Queue order changes.
* A song fails processing.
* Playback progresses.

## Phase 6 — Production Hardening

Add:

* Rate limiting.
* URL allowlist or safe source validation.
* File size limits.
* Max song duration.
* Background jobs for downloading/conversion.
* Cleanup job for temporary MP3 files.
* Error handling for failed downloads.
* Abuse prevention (paying NIM is a good way to already prevent abuse).
* Logging and monitoring.
* Clear copyright/legal policy for submitted URLs.
* Persistent database for songs, payments, and queue history.

## Suggested Stack

This is what I think, research and give me a recommendation:

Frontend:

* React / Next.js
* HTML5 audio player
* Nimiq wallet/payment integration

Backend:

* Node.js / TypeScript
* Express, Fastify, or Next.js API routes
* `yt-dlp`
* `ffmpeg`
* SQLite or PostgreSQL
* WebSockets or SSE

Storage:

* Local temp storage for MVP
* Object storage for production, if needed

## Implementation Priority

Start with the smallest possible technical test:

1. Build frontend URL input.
2. Build backend `/api/prepare-song`.
3. Download YouTube audio server-side.
4. Convert/extract to MP3.
5. Serve the temporary MP3.
6. Return the MP3 URL.
7. Play it in the browser.

Do not implement Nimiq, queue priority, or payments until the media pipeline works reliably.
