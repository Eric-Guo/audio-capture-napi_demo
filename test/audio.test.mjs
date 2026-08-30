import assert from 'node:assert/strict'
import test from 'node:test'
import { createMp3Encoder } from 'wasm-media-encoders'
import {
  formatByteSize,
  formatRecordingProgress,
  isValidMp3,
  pcm16LeToFloat32,
  splitCompletePcm16,
} from '../dist/audio.js'
import {
  BITS_PER_SAMPLE,
  CHANNELS,
  MP3_VBR_QUALITY,
  SAMPLE_RATE,
} from '../dist/index.js'

test('converts signed 16-bit little-endian PCM to normalized floats', () => {
  const pcm = Buffer.alloc(8)
  pcm.writeInt16LE(-32_768, 0)
  pcm.writeInt16LE(-16_384, 2)
  pcm.writeInt16LE(0, 4)
  pcm.writeInt16LE(32_767, 6)
  assert.deepEqual(Array.from(pcm16LeToFloat32(pcm)), [
    -1,
    -0.5,
    0,
    32_767 / 32_768,
  ])
})

test('carries odd PCM bytes across arbitrary callback boundaries', () => {
  const first = splitCompletePcm16(Uint8Array.of(0x00, 0x80, 0xff), null)
  assert.deepEqual([...first.complete], [0x00, 0x80])
  assert.equal(first.trailingByte, 0xff)
  const second = splitCompletePcm16(
    Uint8Array.of(0x7f, 0x00, 0x00),
    first.trailingByte,
  )
  assert.deepEqual([...second.complete], [0xff, 0x7f, 0x00, 0x00])
  assert.equal(second.trailingByte, null)
})

test('formats sample-derived progress', () => {
  assert.equal(formatByteSize(0), '0 B')
  assert.equal(formatByteSize(1_024), '1.0 KiB')
  assert.equal(formatByteSize(1_048_576), '1.0 MiB')
  assert.equal(
    formatRecordingProgress(32_000, 2_048),
    'Recorded 1.0 seconds | 2.0 KiB MP3',
  )
})

test('uses the specified PCM and VBR MP3 format', async () => {
  assert.equal(BITS_PER_SAMPLE, 16)
  assert.equal(CHANNELS, 1)
  assert.equal(SAMPLE_RATE, 16_000)
  assert.equal(MP3_VBR_QUALITY, 4)

  const encoder = await createMp3Encoder()
  encoder.configure({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    vbrQuality: MP3_VBR_QUALITY,
  })
  const mp3 = Buffer.concat([
    Buffer.from(encoder.encode([new Float32Array(SAMPLE_RATE)])),
    Buffer.from(encoder.finalize()),
  ])
  assert.ok(mp3.length > 0)
  assert.equal(isValidMp3(mp3), true)
})
