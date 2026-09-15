import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AudioRecorder,
  createRecorderDependencies,
} from '../dist/recorder.js'

test('completed recordings release the encoder and retain independent MP3 stop results', async () => {
  const fixture = recorder()
  const started = await fixture.recorder.start()
  fixture.capture.onData(Buffer.alloc(8_820))
  const [first, concurrent] = await Promise.all([
    fixture.recorder.stop(started.recordingID),
    fixture.recorder.stop(started.recordingID),
  ])
  assert.ok(first.byteLength > 0)
  assert.deepEqual(concurrent, first)
  assert.equal(fixture.recorder.status().state, 'completed')
  assert.equal(fixture.recorder.status().active, false)
  const repeated = await fixture.recorder.stop(started.recordingID)
  assert.deepEqual(repeated, first)
  first.fill(0)
  assert.deepEqual(await fixture.recorder.stop(started.recordingID), repeated)
  await released(fixture.encoders)

  // Keep the native callback alive, as an addon may do after capture ends.
  fixture.capture.onData(Buffer.alloc(10))
  const next = await fixture.recorder.start()
  assert.notEqual(next.recordingID, started.recordingID)
  fixture.capture.onData(Buffer.alloc(8_820))
  await fixture.recorder.dispose()
  assert.equal(fixture.recorder.status().state, 'completed')
  assert.ok((await fixture.recorder.stop(next.recordingID)).byteLength > 0)
  await released(fixture.encoders)
})

test('failed finalization releases the encoder and preserves repeated-stop errors', async () => {
  const fixture = recorder({ fail: true })
  const started = await fixture.recorder.start()
  const failure = await fixture.recorder.stop(started.recordingID).catch((error) => error)
  assert.equal(failure.code, 'MP3_FINALIZATION_FAILED')
  assert.equal(fixture.recorder.status().state, 'failed')
  assert.equal(fixture.recorder.status().active, false)
  assert.equal(await fixture.recorder.stop(started.recordingID).catch((error) => error), failure)
  await released(fixture.encoders)
  fixture.capture.onData(Buffer.alloc(10))
  await fixture.recorder.dispose()
})

test('automatic duration stops release the encoder without a stop caller', async () => {
  const fixture = recorder({ maxDurationMs: 10 })
  const started = await fixture.recorder.start()
  fixture.capture.onData(Buffer.alloc(8_820))
  for (let attempt = 0; attempt < 100 && fixture.recorder.status().active; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fixture.recorder.status().state, 'completed')
  assert.equal(fixture.recorder.status().endReason, 'max-duration')
  await released(fixture.encoders)
  assert.ok((await fixture.recorder.stop(started.recordingID)).byteLength > 0)
  await fixture.recorder.dispose()
})

test('failed capture starts release the encoder even if native callbacks remain', async () => {
  const fixture = recorder({ start: false })
  await assert.rejects(fixture.recorder.start(), { code: 'CAPTURE_START_FAILED' })
  await released(fixture.encoders)
  fixture.capture.onData(Buffer.alloc(10))
  await fixture.recorder.dispose()
})

function recorder(options = {}) {
  const runtime = createRecorderDependencies()
  // Create the fixture error outside finalize so V8 does not retain its receiver
  // through the error's lazily formatted stack.
  const failure = new Error('finalization failed')
  const encoders = []
  const capture = {
    active: false,
    onData: () => {},
  }
  const addon = {
    startRecording(onData) {
      capture.onData = onData
      capture.active = options.start ?? true
      return capture.active
    },
    stopRecording() {
      capture.active = false
    },
    isRecording: () => capture.active,
    microphoneAuthorizationStatus: () => 3,
  }
  return {
    capture,
    encoders,
    recorder: new AudioRecorder(
      { maxDurationMs: options.maxDurationMs },
      {
        ...runtime,
        platform: 'darwin',
        env: {},
        loadNative: () => ({ addon, error: null }),
        createEncoder: async () => {
          const encoder = await runtime.createEncoder()
          encoders.push(new WeakRef(encoder))
          if (options.fail)
            encoder.finalize = () => {
              throw failure
            }
          return encoder
        },
      },
    ),
  }
}

async function released(encoders) {
  // Leave the job that created the WeakRef before asking for collection.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    gc()
    if (encoders.every(encoder => encoder.deref() === undefined)) return
  }
  assert.deepEqual(encoders.map(encoder => encoder.deref()), encoders.map(() => undefined))
}
