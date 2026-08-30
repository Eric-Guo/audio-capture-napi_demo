import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { inspectAvailability } from '../dist/availability.js'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false

  kill() {
    this.killed = true
    return true
  }
}

function runtime(overrides = {}) {
  return {
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    now: Date.now,
    randomUUID: crypto.randomUUID,
    readTextFile: async () => '',
    spawn: () => {
      throw new Error('not installed')
    },
    loadNative: () => ({ addon: null, error: new Error('missing') }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...overrides,
  }
}

test('reports actionable permission denial', async () => {
  const addon = {
    microphoneAuthorizationStatus: () => 2,
    isRecording: () => false,
    startRecording: () => false,
    stopRecording: () => {},
  }
  const result = await inspectAvailability(
    {},
    runtime({ loadNative: () => ({ addon, error: null }) }),
  )
  assert.equal(result.status.available, false)
  assert.equal(result.status.permission, 'denied')
  assert.equal(result.status.errorCode, 'MICROPHONE_PERMISSION_DENIED')
  assert.match(result.status.guidance, /System Settings/)
})

test('remote hint rejects before loading native code', async () => {
  let loaded = false
  const result = await inspectAvailability(
    { remoteEnvironmentHint: true },
    runtime({
      loadNative: () => {
        loaded = true
        return { addon: null, error: null }
      },
    }),
  )
  assert.equal(loaded, false)
  assert.equal(result.status.environment, 'remote')
  assert.equal(result.status.errorCode, 'REMOTE_ENVIRONMENT')
})

test('selects arecord after a real-device probe when ALSA native is unusable', async () => {
  const child = new FakeChild()
  const result = await inspectAvailability(
    {},
    runtime({
      platform: 'linux',
      readTextFile: async path =>
        path === '/proc/asound/cards' ? '--- no soundcards ---' : 'Linux',
      spawn: (command, args) => {
        assert.equal(command, 'arecord')
        assert.equal(args.at(-1), '/dev/null')
        return child
      },
      setTimeout: (callback, _delay) => setTimeout(callback, 1),
    }),
  )
  assert.equal(child.killed, true)
  assert.equal(result.status.available, true)
  assert.equal(result.status.backend, 'arecord')
})

test('gives WSLg guidance when arecord cannot open a device', async () => {
  const result = await inspectAvailability(
    {},
    runtime({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      readTextFile: async () => '--- no soundcards ---',
      spawn: () => {
        const child = new FakeChild()
        queueMicrotask(() => {
          child.stderr.emit('data', 'audio open error: No such file or directory')
          child.emit('close', 1)
        })
        return child
      },
    }),
  )
  assert.equal(result.status.available, false)
  assert.equal(result.status.environment, 'wsl')
  assert.equal(result.status.errorCode, 'AUDIO_BACKEND_UNAVAILABLE')
  assert.match(result.status.guidance, /WSLg/)
})
