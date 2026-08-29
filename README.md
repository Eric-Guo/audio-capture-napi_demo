# audio-capture-napi demo

A tiny, standalone Node.js 26.7 microphone recorder. It uses the vendored
`audio-capture-napi` native addon and does not import anything from the
`claude-code` project at runtime.

## Run

```sh
node record.js
```

`npm start` is also available, but running the JavaScript file directly gives
Node sole ownership of Ctrl+C on every shell.

Speak into the default microphone, then press Ctrl+C. The program always
overwrites `recording.wav` in the current working directory. Before it exits,
it writes the final WAV sizes, flushes the data, and closes the file.

The recording format is mono, 16 kHz, signed 16-bit PCM. Supported packaged
targets are macOS, Linux, and Windows on arm64 or x64.

On macOS, allow microphone access for the application that launches Node.js
(for example Terminal or Codex) under **System Settings > Privacy & Security >
Microphone**.

## Test

```sh
npm test
```
