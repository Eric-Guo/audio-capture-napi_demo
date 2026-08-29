'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  BITS_PER_SAMPLE,
  CHANNELS,
  OUTPUT_FILENAME,
  SAMPLE_RATE,
  createWavHeader,
} = require('../record.js')

test('creates a valid PCM WAV header', () => {
  const dataBytes = 32_000
  const header = createWavHeader(dataBytes)

  assert.equal(header.length, 44)
  assert.equal(header.toString('ascii', 0, 4), 'RIFF')
  assert.equal(header.readUInt32LE(4), 36 + dataBytes)
  assert.equal(header.toString('ascii', 8, 12), 'WAVE')
  assert.equal(header.toString('ascii', 12, 16), 'fmt ')
  assert.equal(header.readUInt16LE(20), 1)
  assert.equal(header.readUInt16LE(22), CHANNELS)
  assert.equal(header.readUInt32LE(24), SAMPLE_RATE)
  assert.equal(header.readUInt16LE(34), BITS_PER_SAMPLE)
  assert.equal(header.toString('ascii', 36, 40), 'data')
  assert.equal(header.readUInt32LE(40), dataBytes)
  assert.equal(OUTPUT_FILENAME, 'recording.wav')
})

test('rejects an invalid PCM byte count', () => {
  assert.throws(() => createWavHeader(-1), RangeError)
  assert.throws(() => createWavHeader(1.5), RangeError)
})
