import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface NativeAudioAddon {
  startRecording(
    onData: (data: Buffer | Uint8Array | readonly number[]) => void,
    onEnd: () => void,
  ): boolean
  stopRecording(): void
  isRecording(): boolean
  microphoneAuthorizationStatus?(): number
}

const nodeRequire = createRequire(import.meta.url)

export function defaultNativeAddonPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return resolve(
    packageRoot,
    'vendor',
    'audio-capture',
    `${arch}-${platform}`,
    'audio-capture.node',
  )
}

export function loadNativeAddon(
  path: string,
): { addon: NativeAudioAddon | null; error: Error | null } {
  if (!existsSync(path)) {
    return {
      addon: null,
      error: new Error(`Native audio addon is missing: ${path}`),
    }
  }
  try {
    return { addon: nodeRequire(path) as NativeAudioAddon, error: null }
  } catch (error) {
    return {
      addon: null,
      error: new Error(`Could not load native audio addon ${path}`, {
        cause: error,
      }),
    }
  }
}
