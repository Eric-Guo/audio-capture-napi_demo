# Introduction

ESM-only microphone recording for Node.js 26.7 and newer. The library
captures mono, 16 kHz, signed 16-bit PCM and returns an in-memory MP3 encoded
with LAME VBR quality 4.

Native N-API capture is preferred on macOS, Linux, and Windows. Linux uses
`arecord` as its only fallback after opening a real capture device in a short
probe. 

The package has no playback, silence auto-stop, speech-to-text, or file
output behavior.

## API

```js
import {
  checkAvailability,
  createRecorder,
} from '@mixtint/audio-recorder-node'

const availability = await checkAvailability()
if (!availability.available) {
  throw new Error(availability.guidance ?? availability.errorMessage)
}

const recorder = createRecorder({ maxDurationMs: 5 * 60_000 })
const started = await recorder.start()
const mp3 = await recorder.stop(started.recordingID)
await recorder.dispose()
```

`start()` resolves to a structured status with a UUID recording ID. `stop(id)`
resolves to `Uint8Array` MP3 bytes. Repeating `stop()` for the retained ID is
idempotent and returns identical bytes. A completed result remains in memory
until another backend successfully starts recording.

`release(id)` drops the retained MP3 bytes and its capture session references
once a completed result has been consumed, freeing that memory without waiting
for the next recording. It throws `RECORDER_BUSY` while the ID is still
recording and `RECORDING_ID_MISMATCH` when the ID is not the retained result.
After release, `stop(id)` for that ID fails, and the status keeps its duration
and progress but clears the recording ID.

`status()` reports the lifecycle (`idle`, `starting`, `recording`, `stopping`,
`completed`, or `failed`), active backend, Unix-millisecond timestamps,
sample-derived duration and progress, availability and permission information,
environment classification, error details, and actionable guidance.

Recorder options are:

- `nativeAddonPath`: load a native addon extracted elsewhere, such as beside a
  single-executable application.
- `maxDurationMs`: optional positive duration limit; omitted by default.
- `remoteEnvironmentHint`: reject capture when the host is known not to own the
  user's microphone.

`checkAvailability({ refresh: true })` bypasses its process-wide cached result.

## Packaged targets

The package includes native binaries for arm64 and x64 on macOS, Linux, and
Windows. On Linux without a usable ALSA card, install `alsa-utils`; WSL audio
requires WSL2 with WSLg or native Windows execution.

On macOS, grant microphone access to the application that launches Node.js in
**System Settings > Privacy & Security > Microphone**. On Windows, use
**Settings > Privacy & security > Microphone**.

## Development

```sh
pnpm install
pnpm test
pnpm run test:pack
```

Run `pnpm example`, speak, and press Ctrl+C to write `recording.mp3`. Signal
handling and file output live only in that example.
