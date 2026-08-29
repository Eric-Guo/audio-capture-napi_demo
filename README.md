# audio-capture-napi MP3 demo

A tiny, standalone Node.js 26.7 microphone recorder. It uses the vendored
`audio-capture-napi` native addon and `wasm-media-encoders`' WebAssembly LAME
encoder. It does not import anything from the `claude-code` project at runtime.

## Run

```sh
node record.js
```

`npm start` is also available, but running the JavaScript file directly gives
Node sole ownership of Ctrl+C on every shell.

Speak into the default microphone, then press Ctrl+C. The program always
overwrites `recording.mp3` in the current working directory. Before it exits,
it flushes the MP3 encoder and closes the file.

The live progress line is driven by captured audio chunks, not elapsed wall
clock time. It reports sample-derived recording duration together with the MP3
bytes written to disk.

The captured input is mono, 16 kHz, signed 16-bit PCM. It is encoded as a
variable-bitrate MP3 with LAME quality 4. Supported packaged targets are macOS,
Linux, and Windows on arm64 or x64.

On macOS, allow microphone access for the application that launches Node.js
(for example Terminal or Codex) under **System Settings > Privacy & Security >
Microphone**.

## Test

```sh
npm test
```
