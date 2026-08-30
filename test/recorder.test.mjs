import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AudioRecorder } from '../dist/recorder.js'
import { RecorderError } from '../dist/errors.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

class FakeNativeAddon {
  active = false
  starts = 0
  stops = 0
  startSucceeds = true
  queuedChunkOnStop = null
  onData = null
  onEnd = null

  microphoneAuthorizationStatus() {
    return 3
  }

  isRecording() {
    return this.active
  }

  startRecording(onData, onEnd) {
    this.starts += 1
    this.onData = onData
    this.onEnd = onEnd
    if (!this.startSucceeds) return false
    this.active = true
    return true
  }

  stopRecording() {
    this.stops += 1
    this.active = false
    if (this.queuedChunkOnStop) {
      const chunk = this.queuedChunkOnStop
      setTimeout(() => this.onData?.(chunk), 10)
    }
  }

  emitData(chunk) {
    this.onData?.(chunk)
  }

  emitEnd() {
    this.onEnd?.()
  }
}

class FakeEncoder {
  configureCalls = []
  samples = []
  finalizeCalls = 0

  configure(options) {
    this.configureCalls.push(options)
  }

  encode(channels) {
    this.samples.push([...channels[0]])
    return Uint8Array.of(0xff, 0xfb, this.samples.length)
  }

  finalize() {
    this.finalizeCalls += 1
    return Uint8Array.of(0xff, 0xfb, 0x00)
  }
}

function createHarness(options = {}) {
  const addon = new FakeNativeAddon()
  const encoders = []
  let uuid = 0
  let clock = 1_000
  const runtime = {
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    now: () => ++clock,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    readTextFile: async () => '',
    spawn: () => {
      throw new Error('spawn should not be used by native tests')
    },
    loadNative: () => ({ addon, error: null }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    createEncoder: async () => {
      const encoder = new FakeEncoder()
      encoders.push(encoder)
      return encoder
    },
  }
  return {
    addon,
    encoders,
    recorder: new AudioRecorder(options, runtime),
  }
}

test('records, drains queued callbacks, finalizes once, and repeats stop', async () => {
  const { addon, encoders, recorder } = createHarness()
  addon.queuedChunkOnStop = Uint8Array.of(0x00, 0x40)

  const started = await recorder.start()
  assert.equal(started.state, 'recording')
  assert.equal(started.backend, 'native')
  assert.match(started.recordingID, /^[0-9a-f-]{36}$/)

  // The native addon can expose PCM as a plain number[] rather than Buffer.
  addon.emitData([0x00])
  addon.emitData(Uint8Array.of(0x80, 0xff, 0x7f))
  assert.equal(recorder.status().pcmBytes, 4)
  assert.equal(recorder.status().durationMs, 0.125)
  assert.equal(encoders[0].samples[0][0], -1)
  assert.equal(encoders[0].samples[0][1], 32_767 / 32_768)

  const firstStop = recorder.stop(started.recordingID)
  const secondStop = recorder.stop(started.recordingID)
  const [bytes, repeatedBytes] = await Promise.all([firstStop, secondStop])
  assert.deepEqual(repeatedBytes, bytes)
  assert.equal(recorder.status().state, 'completed')
  assert.equal(recorder.status().endReason, 'manual')
  assert.equal(recorder.status().pcmBytes, 6)
  assert.equal(encoders[0].finalizeCalls, 1)
  assert.deepEqual(await recorder.stop(started.recordingID), bytes)
  assert.notStrictEqual(await recorder.stop(started.recordingID), bytes)
})

test('ignores native silence callbacks while capture is active', async () => {
  const { addon, recorder } = createHarness()
  const started = await recorder.start()
  addon.emitEnd()
  assert.equal(recorder.status().state, 'recording')
  await recorder.stop(started.recordingID)
})

test('retains a valid partial MP3 after unexpected native termination', async () => {
  const { addon, recorder } = createHarness()
  const started = await recorder.start()
  addon.emitData(Uint8Array.of(0x00, 0x00))
  addon.active = false
  addon.emitEnd()
  const bytes = await recorder.stop(started.recordingID)
  assert.ok(bytes.length > 0)
  assert.equal(recorder.status().state, 'completed')
  assert.equal(recorder.status().endReason, 'unexpected-backend-end')
  assert.equal(recorder.status().errorCode, 'BACKEND_ENDED_UNEXPECTEDLY')
})

test('cleans stale native state and replaces retained data only after success', async () => {
  const { addon, recorder } = createHarness()
  addon.active = true
  const first = await recorder.start()
  assert.equal(addon.stops, 1)
  addon.emitData(Uint8Array.of(0x00, 0x00))
  const retained = await recorder.stop(first.recordingID)

  addon.startSucceeds = false
  await assert.rejects(recorder.start(), error => {
    assert.ok(error instanceof RecorderError)
    assert.equal(error.code, 'CAPTURE_START_FAILED')
    return true
  })
  assert.deepEqual(await recorder.stop(first.recordingID), retained)

  addon.startSucceeds = true
  const second = await recorder.start()
  await assert.rejects(
    recorder.stop(first.recordingID),
    error => error.code === 'RECORDING_ID_MISMATCH',
  )
  await recorder.stop(second.recordingID)
})

test('rejects a second active start with a busy conflict', async () => {
  const { recorder } = createHarness()
  const started = await recorder.start()
  await assert.rejects(
    recorder.start(),
    error => error instanceof RecorderError && error.code === 'RECORDER_BUSY',
  )
  await recorder.stop(started.recordingID)
})

test('enforces optional maximum duration and supports disposal', async () => {
  const { recorder } = createHarness({ maxDurationMs: 10 })
  const started = await recorder.start()
  await delay(25)
  const bytes = await recorder.stop(started.recordingID)
  assert.ok(bytes.length > 0)
  assert.equal(recorder.status().endReason, 'max-duration')
  await recorder.dispose()
  await assert.rejects(
    recorder.start(),
    error => error instanceof RecorderError && error.code === 'RECORDER_DISPOSED',
  )
})

test('watchdog reconciles native inactivity without an onEnd callback', async () => {
  const { addon, recorder } = createHarness()
  const started = await recorder.start()
  addon.emitData(Uint8Array.of(0x00, 0x00))
  addon.active = false
  await delay(275)
  const bytes = await recorder.stop(started.recordingID)
  assert.ok(bytes.length > 0)
  assert.equal(recorder.status().endReason, 'unexpected-backend-end')
  assert.match(recorder.status().errorMessage, /watchdog/)
})

test('unexpected arecord close retains partial MP3 data', async () => {
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    killed = false
    kill() {
      this.killed = true
      return true
    }
  }

  const probe = new Child()
  const capture = new Child()
  let spawnCount = 0
  const runtime = {
    platform: 'linux',
    arch: 'x64',
    env: {},
    now: Date.now,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    readTextFile: async path =>
      path === '/proc/asound/cards' ? '--- no soundcards ---' : 'Linux',
    spawn: () => (spawnCount++ === 0 ? probe : capture),
    loadNative: () => ({ addon: null, error: new Error('native unavailable') }),
    setTimeout: (callback, milliseconds) =>
      setTimeout(callback, milliseconds === 150 ? 1 : milliseconds),
    clearTimeout,
    setInterval,
    clearInterval,
    createEncoder: async () => new FakeEncoder(),
  }
  const recorder = new AudioRecorder({}, runtime)
  const started = await recorder.start()
  assert.equal(started.backend, 'arecord')
  capture.stdout.emit('data', Uint8Array.of(0x00, 0x00))
  capture.stderr.emit('data', 'device removed')
  capture.emit('close', 1)
  const bytes = await recorder.stop(started.recordingID)
  assert.ok(bytes.length > 0)
  assert.equal(recorder.status().state, 'completed')
  assert.equal(recorder.status().endReason, 'unexpected-backend-end')
  assert.match(recorder.status().errorMessage, /device removed/)
})

test('dispose stops an active capture and prevents reuse', async () => {
  const { addon, recorder } = createHarness()
  await recorder.start()
  await recorder.dispose()
  assert.equal(addon.active, false)
  assert.equal(recorder.status().state, 'completed')
  await assert.rejects(
    recorder.start(),
    error => error instanceof RecorderError && error.code === 'RECORDER_DISPOSED',
  )
})
