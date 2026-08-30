import { checkDefaultAvailability } from './availability.js'
import { AudioRecorder } from './recorder.js'
import type {
  CheckAvailabilityOptions,
  Recorder,
  RecorderOptions,
  RecordingAvailability,
} from './types.js'

export { RecorderError } from './errors.js'
export {
  BITS_PER_SAMPLE,
  CHANNELS,
  MP3_VBR_QUALITY,
  PCM_BYTES_PER_SECOND,
  SAMPLE_RATE,
} from './types.js'
export type {
  CheckAvailabilityOptions,
  PermissionState,
  Recorder,
  RecorderBackend,
  RecorderErrorCode,
  RecorderLifecycleState,
  RecorderOptions,
  RecorderStatus,
  RecordingAvailability,
  RecordingEndReason,
  RecordingEnvironment,
} from './types.js'

export function createRecorder(options: RecorderOptions = {}): Recorder {
  return new AudioRecorder(options)
}

export function checkAvailability(
  options: CheckAvailabilityOptions = {},
): Promise<RecordingAvailability> {
  return checkDefaultAvailability(options.refresh)
}
