export const SAMPLE_RATE = 16_000
export const CHANNELS = 1
export const BITS_PER_SAMPLE = 16
export const MP3_VBR_QUALITY = 4
export const PCM_BYTES_PER_SECOND =
  SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)

export type RecorderLifecycleState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'

export type RecorderBackend = 'native' | 'arecord'

export type RecordingEndReason =
  | 'manual'
  | 'unexpected-backend-end'
  | 'max-duration'

export type PermissionState =
  | 'not-determined'
  | 'restricted'
  | 'denied'
  | 'authorized'
  | 'unknown'

export type RecordingEnvironment = 'local' | 'remote' | 'wsl' | 'headless'

export type RecorderErrorCode =
  | 'RECORDER_BUSY'
  | 'RECORDER_DISPOSED'
  | 'RECORDING_ID_MISMATCH'
  | 'RECORDING_NOT_ACTIVE'
  | 'REMOTE_ENVIRONMENT'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_ARCHITECTURE'
  | 'NATIVE_ADDON_MISSING'
  | 'MICROPHONE_PERMISSION_RESTRICTED'
  | 'MICROPHONE_PERMISSION_DENIED'
  | 'AUDIO_BACKEND_UNAVAILABLE'
  | 'STALE_NATIVE_RECORDING'
  | 'CAPTURE_START_FAILED'
  | 'BACKEND_ENDED_UNEXPECTEDLY'
  | 'PCM_ENCODING_FAILED'
  | 'MP3_FINALIZATION_FAILED'
  | 'INVALID_MP3_ARTIFACT'

export interface RecordingAvailability {
  available: boolean
  backend: RecorderBackend | null
  permission: PermissionState
  environment: RecordingEnvironment
  errorCode: RecorderErrorCode | null
  errorMessage: string | null
  guidance: string | null
}

export interface CheckAvailabilityOptions {
  refresh?: boolean
}

export interface RecorderOptions {
  /** Override the packaged target-specific native addon. */
  nativeAddonPath?: string
  /** Stop automatically after this many milliseconds. There is no default. */
  maxDurationMs?: number
  /** Hint that the process runs somewhere without access to the user's mic. */
  remoteEnvironmentHint?: boolean
}

export interface RecorderStatus {
  state: RecorderLifecycleState
  recordingID: string | null
  active: boolean
  backend: RecorderBackend | null
  startedAt: number | null
  endedAt: number | null
  endReason: RecordingEndReason | null
  pcmBytes: number
  mp3Bytes: number
  durationMs: number
  progress: string
  availability: boolean
  permission: PermissionState
  environment: RecordingEnvironment
  errorCode: RecorderErrorCode | null
  errorMessage: string | null
  guidance: string | null
}

export interface Recorder {
  start(): Promise<RecorderStatus>
  stop(recordingID: string): Promise<Uint8Array>
  release(recordingID: string): void
  status(): RecorderStatus
  dispose(): Promise<void>
}
