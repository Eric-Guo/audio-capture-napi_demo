import { BITS_PER_SAMPLE, PCM_BYTES_PER_SECOND } from './types.js'

export function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  const kibibytes = bytes / 1_024
  if (kibibytes < 1_024) return `${kibibytes.toFixed(1)} KiB`
  return `${(kibibytes / 1_024).toFixed(1)} MiB`
}

export function formatRecordingProgress(
  pcmBytes: number,
  mp3Bytes: number,
): string {
  const seconds = pcmBytes / PCM_BYTES_PER_SECOND
  return `Recorded ${seconds.toFixed(1)} seconds | ${formatByteSize(mp3Bytes)} MP3`
}

export function pcm16LeToFloat32(pcm: Uint8Array): Float32Array {
  if (pcm.byteLength % (BITS_PER_SAMPLE / 8) !== 0) {
    throw new RangeError('PCM chunk must contain complete 16-bit samples')
  }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = new Float32Array(pcm.byteLength / 2)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768
  }
  return samples
}

export interface SplitPcmResult {
  complete: Uint8Array
  trailingByte: number | null
}

/** Join an earlier odd byte to a new callback and retain at most one byte. */
export function splitCompletePcm16(
  chunk: Uint8Array,
  priorTrailingByte: number | null,
): SplitPcmResult {
  const totalLength = chunk.byteLength + (priorTrailingByte === null ? 0 : 1)
  const completeLength = totalLength - (totalLength % 2)
  const joined = new Uint8Array(totalLength)
  let offset = 0
  if (priorTrailingByte !== null) {
    joined[0] = priorTrailingByte
    offset = 1
  }
  joined.set(chunk, offset)
  return {
    complete: joined.subarray(0, completeLength),
    trailingByte:
      completeLength === totalLength ? null : (joined[totalLength - 1] ?? null),
  }
}

export function isValidMp3(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 2) return false
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return true
  }
  for (let index = 0; index < bytes.byteLength - 1; index += 1) {
    if (bytes[index] === 0xff && ((bytes[index + 1] ?? 0) & 0xe0) === 0xe0) {
      return true
    }
  }
  return false
}
