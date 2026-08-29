#!/usr/bin/env node

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createMp3Encoder } = require('wasm-media-encoders')

const OUTPUT_FILENAME = 'recording.mp3'
const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const MP3_VBR_QUALITY = 4

function pcm16LeToFloat32(pcm) {
  const audio = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  if (audio.length % (BITS_PER_SAMPLE / 8) !== 0) {
    throw new RangeError('PCM chunk must contain complete 16-bit samples')
  }

  const samples = new Float32Array(audio.length / (BITS_PER_SAMPLE / 8))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = audio.readInt16LE(index * 2) / 32_768
  }
  return samples
}

function requireNode267OrNewer() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 26 || (major === 26 && minor < 7)) {
    throw new Error(
      `Node.js 26.7.0 or newer is required; current version is ${process.version}`,
    )
  }
}

function loadNativeAddon() {
  const supportedPlatforms = new Set(['darwin', 'linux', 'win32'])
  const supportedArchitectures = new Set(['arm64', 'x64'])

  if (!supportedPlatforms.has(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}`)
  }
  if (!supportedArchitectures.has(process.arch)) {
    throw new Error(`Unsupported architecture: ${process.arch}`)
  }

  const platformDirectory = `${process.arch}-${process.platform}`
  const addonPath = path.join(
    __dirname,
    'vendor',
    'audio-capture',
    platformDirectory,
    'audio-capture.node',
  )

  if (!fs.existsSync(addonPath)) {
    throw new Error(`Native audio addon is missing: ${addonPath}`)
  }

  try {
    return require(addonPath)
  } catch (error) {
    throw new Error(`Could not load ${addonPath}: ${error.message}`, {
      cause: error,
    })
  }
}

function writeAllSync(fileDescriptor, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    offset += fs.writeSync(
      fileDescriptor,
      buffer,
      offset,
      buffer.length - offset,
    )
  }
}

function microphonePermissionError(status) {
  if (status === 1) {
    return 'Microphone access is restricted by the operating system.'
  }
  if (status === 2) {
    if (process.platform === 'darwin') {
      return (
        'Microphone access is denied. Open System Settings > Privacy & Security ' +
        '> Microphone and allow the terminal or Codex application that runs Node.js.'
      )
    }
    if (process.platform === 'win32') {
      return (
        'Microphone access is denied. Enable microphone access in Windows ' +
        'Settings > Privacy & security > Microphone.'
      )
    }
    return 'Microphone access is denied.'
  }
  return null
}

async function main() {
  let addon
  let encoder
  let fileDescriptor = null
  let pcmBytes = 0
  let mp3Bytes = 0
  let acceptingAudio = false
  let shuttingDown = false
  let fileFinished = false
  let progressTimer = null
  let shutdownTimer = null
  const outputPath = path.resolve(process.cwd(), OUTPUT_FILENAME)

  function writeEncodedChunk(chunk) {
    if (chunk.length === 0) return
    const copy = Buffer.from(chunk)
    writeAllSync(fileDescriptor, copy)
    mp3Bytes += copy.length
  }

  function finishFile(exitCode, precedingError) {
    if (fileFinished) return
    fileFinished = true
    acceptingAudio = false
    let closeError = null

    if (fileDescriptor !== null) {
      try {
        if (encoder) {
          writeEncodedChunk(encoder.finalize())
        }
        fs.fsyncSync(fileDescriptor)
      } catch (error) {
        closeError = error
      }

      try {
        fs.closeSync(fileDescriptor)
      } catch (error) {
        closeError ??= error
      }
      fileDescriptor = null
    }

    if (precedingError || closeError) {
      console.error(`Recording failed: ${(precedingError || closeError).message}`)
      process.exitCode = 1
      return
    }

    const seconds = pcmBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))
    console.log(
      `Saved ${outputPath} (${seconds.toFixed(1)} seconds, ${mp3Bytes} MP3 bytes).`,
    )
    process.exitCode = exitCode
  }

  function stopRecording(exitCode = 0, error = null) {
    if (fileFinished) return
    if (error) acceptingAudio = false
    if (shuttingDown) {
      if (shutdownTimer !== null) {
        clearTimeout(shutdownTimer)
        shutdownTimer = null
      }
      finishFile(exitCode, error)
      return
    }
    shuttingDown = true

    if (progressTimer !== null) {
      clearInterval(progressTimer)
      progressTimer = null
    }

    try {
      if (addon && addon.isRecording()) {
        addon.stopRecording()
      }
    } catch (stopError) {
      error ??= stopError
    }

    // stopRecording() can leave already-queued N-API data callbacks. Give
    // them one short turn to reach the file before replacing the WAV header.
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null
      finishFile(exitCode, error)
    }, 150)
  }

  try {
    requireNode267OrNewer()
    addon = loadNativeAddon()

    const permissionStatus =
      typeof addon.microphoneAuthorizationStatus === 'function'
        ? addon.microphoneAuthorizationStatus()
        : 3
    const permissionError = microphonePermissionError(permissionStatus)
    if (permissionError) {
      throw new Error(permissionError)
    }

    encoder = await createMp3Encoder()
    encoder.configure({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      vbrQuality: MP3_VBR_QUALITY,
    })

    fileDescriptor = fs.openSync(outputPath, 'w')
    acceptingAudio = true

    process.once('SIGINT', () => {
      process.stdout.write('\n')
      stopRecording()
    })
    process.once('SIGTERM', () => stopRecording())
    if (process.platform !== 'win32') {
      process.once('SIGHUP', () => stopRecording())
    }

    const started = addon.startRecording(
      chunk => {
        if (!acceptingAudio) return
        const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

        try {
          const samples = pcm16LeToFloat32(audio)
          writeEncodedChunk(encoder.encode([samples]))
          pcmBytes += audio.length
        } catch (error) {
          stopRecording(1, error)
        }
      },
      () => {
        // The addon may report silence, but this demo records until Ctrl+C.
      },
    )

    if (!started) {
      throw new Error('The native addon could not start the default microphone')
    }

    console.log(`Recording microphone audio to ${outputPath}`)
    console.log('Press Ctrl+C to stop, finalize, and close the MP3 file.')

    progressTimer = setInterval(() => {
      const seconds =
        pcmBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))
      process.stdout.write(`\rRecorded ${seconds.toFixed(1)} seconds`)
    }, 1_000)
  } catch (error) {
    if (fileDescriptor !== null || (addon && addon.isRecording())) {
      stopRecording(1, error)
    } else {
      console.error(`Recording failed: ${error.message}`)
      process.exitCode = 1
    }
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  BITS_PER_SAMPLE,
  CHANNELS,
  MP3_VBR_QUALITY,
  OUTPUT_FILENAME,
  SAMPLE_RATE,
  pcm16LeToFloat32,
}
