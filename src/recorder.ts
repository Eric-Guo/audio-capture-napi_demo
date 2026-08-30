import type { ChildProcess } from 'node:child_process'
import { createMp3Encoder } from 'wasm-media-encoders'
import {
  isValidMp3,
  formatRecordingProgress,
  pcm16LeToFloat32,
  splitCompletePcm16,
} from './audio.js'
import {
  createRuntimeDependencies,
  inspectAvailability,
  probeArecord,
  type RuntimeDependencies,
} from './availability.js'
import { errorMessage, RecorderError } from './errors.js'
import type { NativeAudioAddon } from './native.js'
import {
  CHANNELS,
  MP3_VBR_QUALITY,
  PCM_BYTES_PER_SECOND,
  SAMPLE_RATE,
  type Recorder,
  type RecorderBackend,
  type RecorderErrorCode,
  type RecorderOptions,
  type RecorderStatus,
  type RecordingAvailability,
  type RecordingEndReason,
} from './types.js'

const NATIVE_DRAIN_MS = 150
const WATCHDOG_INTERVAL_MS = 250

interface Mp3Encoder {
  configure(options: {
    sampleRate: number
    channels: 1
    vbrQuality: number
  }): void
  encode(samples: readonly Float32Array[]): Uint8Array
  finalize(): Uint8Array
}

export interface RecorderDependencies extends RuntimeDependencies {
  createEncoder(): Promise<Mp3Encoder>
}

export function createRecorderDependencies(): RecorderDependencies {
  return {
    ...createRuntimeDependencies(),
    createEncoder: createMp3Encoder,
  }
}

interface RetainedRecording {
  id: string
  bytes: Uint8Array
}

interface Session {
  id: string
  encoder: Mp3Encoder
  addon: NativeAudioAddon | null
  child: ChildProcess | null
  backend: RecorderBackend | null
  acceptingAudio: boolean
  encodedChunks: Uint8Array[]
  pcmBytes: number
  mp3Bytes: number
  trailingByte: number | null
  endReason: RecordingEndReason | null
  terminalError: RecorderError | null
  resultPromise: Promise<Uint8Array>
  resolveResult(bytes: Uint8Array): void
  rejectResult(error: RecorderError): void
  finalizationStarted: boolean
  finalized: boolean
  drainTimer: NodeJS.Timeout | null
  maxDurationTimer: NodeJS.Timeout | null
  watchdogTimer: NodeJS.Timeout | null
  stderr: string
}

const INITIAL_AVAILABILITY: RecordingAvailability = {
  available: false,
  backend: null,
  permission: 'unknown',
  environment: 'local',
  errorCode: null,
  errorMessage: null,
  guidance: null,
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes)
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function recorderError(
  code: RecorderErrorCode,
  message: string,
  cause?: unknown,
): RecorderError {
  return new RecorderError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

export class AudioRecorder implements Recorder {
  readonly #options: RecorderOptions
  readonly #runtime: RecorderDependencies
  #disposed = false
  #session: Session | null = null
  #retained: RetainedRecording | null = null
  #availability = { ...INITIAL_AVAILABILITY }
  #status: RecorderStatus = {
    state: 'idle',
    recordingID: null,
    active: false,
    backend: null,
    startedAt: null,
    endedAt: null,
    endReason: null,
    pcmBytes: 0,
    mp3Bytes: 0,
    durationMs: 0,
    progress: formatRecordingProgress(0, 0),
    availability: false,
    permission: 'unknown',
    environment: 'local',
    errorCode: null,
    errorMessage: null,
    guidance: null,
  }

  constructor(options: RecorderOptions = {}, dependencies = createRecorderDependencies()) {
    if (
      options.maxDurationMs !== undefined &&
      (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0)
    ) {
      throw new RangeError('maxDurationMs must be a positive finite number')
    }
    this.#options = { ...options }
    this.#runtime = dependencies
  }

  status(): RecorderStatus {
    return { ...this.#status }
  }

  async start(): Promise<RecorderStatus> {
    this.#assertNotDisposed()
    if (
      this.#status.state === 'starting' ||
      this.#status.state === 'recording' ||
      this.#status.state === 'stopping'
    ) {
      throw recorderError(
        'RECORDER_BUSY',
        `Recording ${this.#status.recordingID ?? ''} is still active.`,
      )
    }

    const recordingID = this.#runtime.randomUUID()
    this.#status = {
      ...this.#status,
      state: 'starting',
      recordingID,
      active: true,
      backend: null,
      startedAt: null,
      endedAt: null,
      endReason: null,
      pcmBytes: 0,
      mp3Bytes: 0,
      durationMs: 0,
      progress: formatRecordingProgress(0, 0),
      errorCode: null,
      errorMessage: null,
      guidance: null,
    }

    try {
      const inspection = await inspectAvailability(this.#options, this.#runtime)
      this.#assertNotDisposed()
      this.#applyAvailability(inspection.status)
      if (!inspection.status.available || !inspection.status.backend) {
        throw recorderError(
          inspection.status.errorCode ?? 'AUDIO_BACKEND_UNAVAILABLE',
          inspection.status.errorMessage ?? 'Audio recording is unavailable.',
        )
      }

      if (inspection.addon?.isRecording()) {
        inspection.addon.stopRecording()
        await this.#delay(NATIVE_DRAIN_MS)
        if (inspection.addon.isRecording()) {
          throw recorderError(
            'STALE_NATIVE_RECORDING',
            'The native addon still reports an active stale recording after stop.',
          )
        }
      }

      const encoder = await this.#runtime.createEncoder()
      if (this.#disposed) {
        try {
          encoder.finalize()
        } catch {
          // Disposal takes precedence over encoder cleanup errors.
        }
        this.#assertNotDisposed()
      }
      encoder.configure({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        vbrQuality: MP3_VBR_QUALITY,
      })
      const session = this.#createSession(recordingID, encoder, inspection.addon)
      this.#session = session

      let started = false
      if (inspection.status.backend === 'native' && inspection.addon) {
        started = this.#startNative(session, inspection.addon)
        if (!started) {
          const permissionFailure = this.#nativePermissionFailure(
            inspection.addon,
          )
          if (permissionFailure) throw permissionFailure
        }
      }
      if (inspection.status.backend === 'arecord') {
        started = this.#startArecord(session)
      } else if (!started && this.#runtime.platform === 'linux') {
        const probe = await probeArecord(this.#runtime)
        this.#assertNotDisposed()
        if (probe.ok) {
          started = this.#startArecord(session)
          if (started) {
            this.#availability = {
              ...this.#availability,
              available: true,
              backend: 'arecord',
              errorCode: null,
              errorMessage: null,
              guidance: null,
            }
          }
        }
      }
      if (!started) {
        this.#discardStartingSession(session)
        throw recorderError(
          'CAPTURE_START_FAILED',
          'The selected audio backend could not start the default microphone.',
        )
      }

      // The previous result is replaced only after a backend really starts.
      this.#retained = null
      if (session.finalizationStarted) {
        await session.resultPromise
        return this.status()
      }
      const startedAt = this.#runtime.now()
      this.#status = {
        ...this.#status,
        state: 'recording',
        active: true,
        backend: session.backend,
        startedAt,
        availability: true,
        permission: this.#availability.permission,
        environment: this.#availability.environment,
      }
      this.#armSessionTimers(session)
      return this.status()
    } catch (error) {
      const failure =
        error instanceof RecorderError
          ? error
          : recorderError(
              'CAPTURE_START_FAILED',
              `Could not start audio recording: ${errorMessage(error)}`,
              error,
            )
      if (this.#session && this.#status.state === 'starting') {
        this.#discardStartingSession(this.#session)
      }
      this.#status = {
        ...this.#status,
        state: 'failed',
        active: false,
        backend: null,
        endedAt: this.#runtime.now(),
        availability: this.#availability.available,
        permission: this.#availability.permission,
        environment: this.#availability.environment,
        errorCode: failure.code,
        errorMessage: failure.message,
        guidance:
          this.#availability.guidance ?? this.#guidanceForError(failure.code),
      }
      throw failure
    }
  }

  async stop(recordingID: string): Promise<Uint8Array> {
    if (this.#retained?.id === recordingID) {
      return copyBytes(this.#retained.bytes)
    }
    const session = this.#session
    if (!session || session.id !== recordingID) {
      throw recorderError(
        'RECORDING_ID_MISMATCH',
        `Recording ${recordingID} is not the current or retained recording.`,
      )
    }
    if (session.finalizationStarted) return session.resultPromise
    if (this.#status.state !== 'recording') {
      throw recorderError(
        'RECORDING_NOT_ACTIVE',
        `Recording ${recordingID} is not active.`,
      )
    }
    this.#requestSessionStop(session, 'manual', null, NATIVE_DRAIN_MS)
    return session.resultPromise
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const session = this.#session
    if (
      session &&
      !session.finalizationStarted &&
      (this.#status.state === 'recording' || this.#status.state === 'stopping')
    ) {
      this.#requestSessionStop(session, 'manual', null, NATIVE_DRAIN_MS)
    }
    if (session?.finalizationStarted) {
      await session.resultPromise.catch(() => undefined)
    }
  }

  #createSession(
    id: string,
    encoder: Mp3Encoder,
    addon: NativeAudioAddon | null,
  ): Session {
    let resolveResult!: (bytes: Uint8Array) => void
    let rejectResult!: (error: RecorderError) => void
    const resultPromise = new Promise<Uint8Array>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // Unexpected termination can reject without a concurrent stop() caller.
    void resultPromise.catch(() => undefined)
    return {
      id,
      encoder,
      addon,
      child: null,
      backend: null,
      acceptingAudio: true,
      encodedChunks: [],
      pcmBytes: 0,
      mp3Bytes: 0,
      trailingByte: null,
      endReason: null,
      terminalError: null,
      resultPromise,
      resolveResult,
      rejectResult,
      finalizationStarted: false,
      finalized: false,
      drainTimer: null,
      maxDurationTimer: null,
      watchdogTimer: null,
      stderr: '',
    }
  }

  #startNative(session: Session, addon: NativeAudioAddon): boolean {
    try {
      const started = addon.startRecording(
        chunk => this.#acceptPcm(session, chunk),
        () => {
          if (this.#session !== session || session.finalizationStarted) return
          let stillActive = false
          try {
            stillActive = addon.isRecording()
          } catch (error) {
            session.terminalError = recorderError(
              'BACKEND_ENDED_UNEXPECTEDLY',
              `Could not reconcile native capture state: ${errorMessage(error)}`,
              error,
            )
          }
          // The native callback can signal silence while capture remains live.
          if (stillActive) return
          this.#requestSessionStop(
            session,
            'unexpected-backend-end',
            session.terminalError ??
              recorderError(
                'BACKEND_ENDED_UNEXPECTEDLY',
                'Native capture ended unexpectedly.',
              ),
            0,
          )
        },
      )
      if (!started) return false
      session.backend = 'native'
      return true
    } catch {
      return false
    }
  }

  #startArecord(session: Session): boolean {
    let child: ChildProcess
    try {
      child = this.#runtime.spawn('arecord', [
        '-f',
        'S16_LE',
        '-r',
        String(SAMPLE_RATE),
        '-c',
        String(CHANNELS),
        '-t',
        'raw',
        '-q',
        '-',
      ])
    } catch {
      return false
    }
    session.child = child
    session.backend = 'arecord'
    child.stdout?.on('data', chunk => {
      this.#acceptPcm(session, chunk as Buffer)
    })
    child.stderr?.on('data', chunk => {
      if (session.stderr.length < 8_192) session.stderr += String(chunk)
    })
    child.once('error', error => {
      this.#requestSessionStop(
        session,
        'unexpected-backend-end',
        recorderError(
          'BACKEND_ENDED_UNEXPECTEDLY',
          `arecord failed: ${errorMessage(error)}`,
          error,
        ),
        0,
      )
    })
    child.once('close', code => {
      if (session.finalizationStarted) {
        this.#finalizeNow(session)
        return
      }
      const detail = session.stderr.trim()
      this.#requestSessionStop(
        session,
        'unexpected-backend-end',
        recorderError(
          'BACKEND_ENDED_UNEXPECTEDLY',
          `arecord ended unexpectedly${code === null ? '' : ` with code ${code}`}${detail ? `: ${detail}` : '.'}`,
        ),
        0,
      )
    })
    return true
  }

  #armSessionTimers(session: Session): void {
    if (session.backend === 'native' && session.addon) {
      session.watchdogTimer = this.#runtime.setInterval(() => {
        if (
          this.#session !== session ||
          session.finalizationStarted ||
          this.#status.state !== 'recording'
        ) {
          return
        }
        try {
          if (session.addon?.isRecording()) return
        } catch {
          // An unreadable activity state is terminal too.
        }
        this.#requestSessionStop(
          session,
          'unexpected-backend-end',
          recorderError(
            'BACKEND_ENDED_UNEXPECTEDLY',
            'The native capture watchdog found an inactive backend.',
          ),
          0,
        )
      }, WATCHDOG_INTERVAL_MS)
      session.watchdogTimer.unref()
    }
    if (this.#options.maxDurationMs !== undefined) {
      session.maxDurationTimer = this.#runtime.setTimeout(() => {
        this.#requestSessionStop(session, 'max-duration', null, NATIVE_DRAIN_MS)
      }, this.#options.maxDurationMs)
    }
  }

  #acceptPcm(
    session: Session,
    chunk: Uint8Array | readonly number[],
  ): void {
    if (this.#session !== session || !session.acceptingAudio) return
    try {
      // The native addon currently supplies a plain number[] on macOS even
      // though its historical wrapper typed callbacks as Buffer. Normalize at
      // the boundary; arecord continues to arrive as Buffer/Uint8Array.
      const bytes =
        chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk)
      const split = splitCompletePcm16(bytes, session.trailingByte)
      session.trailingByte = split.trailingByte
      if (split.complete.byteLength === 0) return
      const encoded = session.encoder.encode([pcm16LeToFloat32(split.complete)])
      if (encoded.byteLength > 0) {
        const copy = copyBytes(encoded)
        session.encodedChunks.push(copy)
        session.mp3Bytes += copy.byteLength
      }
      session.pcmBytes += split.complete.byteLength
      this.#updateProgress(session)
    } catch (error) {
      session.acceptingAudio = false
      this.#requestSessionStop(
        session,
        'unexpected-backend-end',
        recorderError(
          'PCM_ENCODING_FAILED',
          `Could not encode captured PCM: ${errorMessage(error)}`,
          error,
        ),
        0,
      )
    }
  }

  #requestSessionStop(
    session: Session,
    reason: RecordingEndReason,
    terminalError: RecorderError | null,
    drainMs: number,
  ): void {
    if (this.#session !== session || session.finalizationStarted) return
    session.finalizationStarted = true
    session.endReason = reason
    session.terminalError = terminalError
    this.#status = {
      ...this.#status,
      state: 'stopping',
      active: true,
      endReason: reason,
      errorCode: terminalError?.code ?? null,
      errorMessage: terminalError?.message ?? null,
    }
    if (session.maxDurationTimer) {
      this.#runtime.clearTimeout(session.maxDurationTimer)
      session.maxDurationTimer = null
    }
    if (session.watchdogTimer) {
      this.#runtime.clearInterval(session.watchdogTimer)
      session.watchdogTimer = null
    }
    try {
      if (session.backend === 'native' && session.addon?.isRecording()) {
        session.addon.stopRecording()
      } else if (session.backend === 'arecord' && session.child) {
        session.child.kill('SIGTERM')
      }
    } catch (error) {
      session.terminalError ??= recorderError(
        'BACKEND_ENDED_UNEXPECTEDLY',
        `Could not stop the audio backend: ${errorMessage(error)}`,
        error,
      )
    }
    session.drainTimer = this.#runtime.setTimeout(
      () => this.#finalizeNow(session),
      drainMs,
    )
  }

  #finalizeNow(session: Session): void {
    if (
      this.#session !== session ||
      !session.finalizationStarted ||
      session.finalized
    ) {
      return
    }
    session.finalized = true
    if (session.drainTimer) {
      this.#runtime.clearTimeout(session.drainTimer)
      session.drainTimer = null
    }
    session.acceptingAudio = false

    let finalizationError: RecorderError | null = null
    try {
      const finalChunk = session.encoder.finalize()
      if (finalChunk.byteLength > 0) {
        const copy = copyBytes(finalChunk)
        session.encodedChunks.push(copy)
        session.mp3Bytes += copy.byteLength
      }
    } catch (error) {
      finalizationError = recorderError(
        'MP3_FINALIZATION_FAILED',
        `Could not finalize MP3 encoding: ${errorMessage(error)}`,
        error,
      )
    }

    const artifact = concatBytes(session.encodedChunks)
    const endedAt = this.#runtime.now()
    this.#updateProgress(session)
    if (isValidMp3(artifact)) {
      this.#retained = { id: session.id, bytes: copyBytes(artifact) }
      const partialError = session.terminalError ?? finalizationError
      this.#status = {
        ...this.#status,
        state: 'completed',
        active: false,
        endedAt,
        endReason: session.endReason,
        pcmBytes: session.pcmBytes,
        mp3Bytes: artifact.byteLength,
        durationMs: (session.pcmBytes / PCM_BYTES_PER_SECOND) * 1_000,
        progress: formatRecordingProgress(session.pcmBytes, artifact.byteLength),
        errorCode: partialError?.code ?? null,
        errorMessage: partialError?.message ?? null,
        guidance: partialError
          ? this.#guidanceForError(partialError.code)
          : null,
      }
      session.resolveResult(copyBytes(artifact))
      return
    }

    const failure =
      finalizationError ??
      session.terminalError ??
      recorderError(
        'INVALID_MP3_ARTIFACT',
        'The encoder did not produce a valid MP3 artifact.',
      )
    this.#status = {
      ...this.#status,
      state: 'failed',
      active: false,
      endedAt,
      endReason: session.endReason,
      pcmBytes: session.pcmBytes,
      mp3Bytes: artifact.byteLength,
      durationMs: (session.pcmBytes / PCM_BYTES_PER_SECOND) * 1_000,
      progress: formatRecordingProgress(session.pcmBytes, artifact.byteLength),
      errorCode: failure.code,
      errorMessage: failure.message,
      guidance: this.#guidanceForError(failure.code),
    }
    session.rejectResult(failure)
  }

  #updateProgress(session: Session): void {
    if (this.#session !== session) return
    this.#status = {
      ...this.#status,
      pcmBytes: session.pcmBytes,
      mp3Bytes: session.mp3Bytes,
      durationMs: (session.pcmBytes / PCM_BYTES_PER_SECOND) * 1_000,
      progress: formatRecordingProgress(session.pcmBytes, session.mp3Bytes),
    }
  }

  #applyAvailability(availability: RecordingAvailability): void {
    this.#availability = { ...availability }
    this.#status = {
      ...this.#status,
      availability: availability.available,
      permission: availability.permission,
      environment: availability.environment,
      guidance: availability.guidance,
    }
  }

  #delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.#runtime.setTimeout(resolve, ms)
    })
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw recorderError('RECORDER_DISPOSED', 'The recorder has been disposed.')
    }
  }

  #discardStartingSession(session: Session): void {
    session.acceptingAudio = false
    if (!session.finalized) {
      session.finalized = true
      try {
        session.encoder.finalize()
      } catch {
        // The start failure remains the actionable error.
      }
    }
    session.resolveResult(new Uint8Array())
    if (this.#session === session) this.#session = null
  }

  #nativePermissionFailure(addon: NativeAudioAddon): RecorderError | null {
    let status: number | undefined
    try {
      status = addon.microphoneAuthorizationStatus?.()
    } catch {
      return null
    }
    if (status === 1) {
      this.#availability = {
        ...this.#availability,
        available: false,
        backend: null,
        permission: 'restricted',
        errorCode: 'MICROPHONE_PERMISSION_RESTRICTED',
        errorMessage: 'Microphone access is restricted by the operating system.',
        guidance: this.#guidanceForError('MICROPHONE_PERMISSION_RESTRICTED'),
      }
      return recorderError(
        'MICROPHONE_PERMISSION_RESTRICTED',
        'Microphone access is restricted by the operating system.',
      )
    }
    if (status === 2) {
      this.#availability = {
        ...this.#availability,
        available: false,
        backend: null,
        permission: 'denied',
        errorCode: 'MICROPHONE_PERMISSION_DENIED',
        errorMessage: 'Microphone access is denied.',
        guidance: this.#guidanceForError('MICROPHONE_PERMISSION_DENIED'),
      }
      return recorderError(
        'MICROPHONE_PERMISSION_DENIED',
        'Microphone access is denied.',
      )
    }
    return null
  }

  #guidanceForError(code: RecorderErrorCode): string {
    if (code === 'MICROPHONE_PERMISSION_DENIED') {
      return this.#runtime.platform === 'darwin'
        ? 'Open System Settings > Privacy & Security > Microphone and allow the application that launches Node.js.'
        : this.#runtime.platform === 'win32'
          ? 'Open Windows Settings > Privacy & security > Microphone and allow desktop applications to use the microphone.'
          : 'Allow microphone access for the Node.js process.'
    }
    if (code === 'MICROPHONE_PERMISSION_RESTRICTED') {
      return 'Ask the device administrator to allow microphone access for Node.js.'
    }
    if (
      code === 'CAPTURE_START_FAILED' ||
      code === 'BACKEND_ENDED_UNEXPECTEDLY'
    ) {
      return 'Verify that a default capture device is connected and not exclusively held by another application, then start a new recording.'
    }
    if (code === 'STALE_NATIVE_RECORDING') {
      return 'Restart the Node.js process to reset the native capture backend.'
    }
    if (
      code === 'PCM_ENCODING_FAILED' ||
      code === 'MP3_FINALIZATION_FAILED' ||
      code === 'INVALID_MP3_ARTIFACT'
    ) {
      return 'Discard this recording and start a new one. If the error repeats, restart the Node.js process.'
    }
    return this.#availability.guidance ?? 'Review the recorder error and retry.'
  }
}
