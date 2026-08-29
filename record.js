#!/usr/bin/env node

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const OUTPUT_FILENAME = 'recording.wav'
const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const WAV_HEADER_BYTES = 44
const MAX_WAV_DATA_BYTES = 0xffffffff - 36

function createWavHeader(dataBytes) {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0) {
    throw new RangeError('dataBytes must be a non-negative safe integer')
  }
  if (dataBytes > MAX_WAV_DATA_BYTES) {
    throw new RangeError('Recording is too large for a standard WAV file')
  }

  const bytesPerSample = BITS_PER_SAMPLE / 8
  const blockAlign = CHANNELS * bytesPerSample
  const byteRate = SAMPLE_RATE * blockAlign
  const header = Buffer.alloc(WAV_HEADER_BYTES)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  return header
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

function main() {
  let addon
  let fileDescriptor = null
  let dataBytes = 0
  let acceptingAudio = false
  let shuttingDown = false
  let fileFinished = false
  let progressTimer = null
  let shutdownTimer = null
  const outputPath = path.resolve(process.cwd(), OUTPUT_FILENAME)

  function updateWavHeader() {
    if (fileDescriptor === null) return
    fs.writeSync(
      fileDescriptor,
      createWavHeader(dataBytes),
      0,
      WAV_HEADER_BYTES,
      0,
    )
  }

  function finishFile(exitCode, precedingError) {
    if (fileFinished) return
    fileFinished = true
    acceptingAudio = false
    let closeError = null

    if (fileDescriptor !== null) {
      try {
        updateWavHeader()
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

    const seconds = dataBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))
    console.log(
      `Saved ${outputPath} (${seconds.toFixed(1)} seconds, ${dataBytes} PCM bytes).`,
    )
    process.exitCode = exitCode
  }

  function stopRecording(exitCode = 0, error = null) {
    if (fileFinished) return
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

    fileDescriptor = fs.openSync(outputPath, 'w')
    writeAllSync(fileDescriptor, createWavHeader(0))
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

        if (dataBytes + audio.length > MAX_WAV_DATA_BYTES) {
          stopRecording(1, new Error('Recording exceeded the WAV 4 GiB limit'))
          return
        }

        try {
          writeAllSync(fileDescriptor, audio)
          dataBytes += audio.length
          // Keep the on-disk file self-consistent after every chunk. This
          // preserves a valid WAV even if a parent launcher exits abruptly.
          updateWavHeader()
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
    console.log('Press Ctrl+C to stop, finalize, and close the WAV file.')

    progressTimer = setInterval(() => {
      const seconds =
        dataBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))
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
  OUTPUT_FILENAME,
  SAMPLE_RATE,
  createWavHeader,
}
