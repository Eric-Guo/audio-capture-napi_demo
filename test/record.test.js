'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createMp3Encoder } = require('wasm-media-encoders')

const {
  BITS_PER_SAMPLE,
  CHANNELS,
  MP3_VBR_QUALITY,
  OUTPUT_FILENAME,
  SAMPLE_RATE,
  pcm16LeToFloat32,
} = require('../record.js')

test('converts signed 16-bit little-endian PCM to normalized floats', () => {
  const pcm = Buffer.alloc(8)
  pcm.writeInt16LE(-32_768, 0)
  pcm.writeInt16LE(-16_384, 2)
  pcm.writeInt16LE(0, 4)
  pcm.writeInt16LE(32_767, 6)

  const samples = pcm16LeToFloat32(pcm)
  assert.deepEqual(Array.from(samples), [-1, -0.5, 0, 32_767 / 32_768])
})

test('rejects a partial 16-bit PCM sample', () => {
  assert.throws(() => pcm16LeToFloat32(Buffer.alloc(1)), RangeError)
})

test('uses mono 16 kHz PCM and writes an MP3', () => {
  assert.equal(BITS_PER_SAMPLE, 16)
  assert.equal(CHANNELS, 1)
  assert.equal(SAMPLE_RATE, 16_000)
  assert.equal(MP3_VBR_QUALITY, 4)
  assert.equal(OUTPUT_FILENAME, 'recording.mp3')
})

test('encodes and finalizes MPEG audio with the WASM encoder', async () => {
  const encoder = await createMp3Encoder()
  encoder.configure({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    vbrQuality: MP3_VBR_QUALITY,
  })

  const samples = new Float32Array(SAMPLE_RATE)
  const encoded = Buffer.from(encoder.encode([samples]))
  const finalized = Buffer.from(encoder.finalize())
  const mp3 = Buffer.concat([encoded, finalized])

  assert.ok(mp3.length > 0)
  assert.equal(mp3[0], 0xff)
  assert.equal(mp3[1] & 0xe0, 0xe0)
})
