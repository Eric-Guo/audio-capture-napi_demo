import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import {
  CHANNELS,
  SAMPLE_RATE,
  type PermissionState,
  type RecordingAvailability,
  type RecordingEnvironment,
  type RecorderOptions,
} from './types.js'
import {
  defaultNativeAddonPath,
  loadNativeAddon,
  type NativeAudioAddon,
} from './native.js'

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>([
  'darwin',
  'linux',
  'win32',
])
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64'])

export interface RuntimeDependencies {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  now(): number
  randomUUID(): string
  readTextFile(path: string): Promise<string>
  spawn(command: string, args: readonly string[]): ChildProcess
  loadNative(path: string): {
    addon: NativeAudioAddon | null
    error: Error | null
  }
  setTimeout(callback: () => void, delay: number): NodeJS.Timeout
  clearTimeout(timer: NodeJS.Timeout): void
  setInterval(callback: () => void, delay: number): NodeJS.Timeout
  clearInterval(timer: NodeJS.Timeout): void
}

export function createRuntimeDependencies(): RuntimeDependencies {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    now: Date.now,
    randomUUID,
    readTextFile: path => readFile(path, 'utf8'),
    spawn: (command, args) =>
      spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    loadNative: loadNativeAddon,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
}

export interface AvailabilityInspection {
  status: RecordingAvailability
  addon: NativeAudioAddon | null
}

function permissionState(rawStatus: number | undefined): PermissionState {
  if (rawStatus === 0) return 'not-determined'
  if (rawStatus === 1) return 'restricted'
  if (rawStatus === 2) return 'denied'
  if (rawStatus === 3) return 'authorized'
  return 'unknown'
}

async function isWsl(runtime: RuntimeDependencies): Promise<boolean> {
  if (runtime.platform !== 'linux') return false
  if (runtime.env.WSL_DISTRO_NAME || runtime.env.WSL_INTEROP) return true
  return runtime.readTextFile('/proc/version').then(
    value => /microsoft|wsl/i.test(value),
    () => false,
  )
}

async function linuxHasAlsaCards(
  runtime: RuntimeDependencies,
): Promise<boolean> {
  if (runtime.platform !== 'linux') return true
  return runtime.readTextFile('/proc/asound/cards').then(
    cards => {
      const value = cards.trim()
      return value !== '' && !value.toLowerCase().includes('no soundcards')
    },
    () => false,
  )
}

export interface ArecordProbeResult {
  ok: boolean
  stderr: string
}

export function probeArecord(
  runtime: RuntimeDependencies,
): Promise<ArecordProbeResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = runtime.spawn('arecord', [
        '-f',
        'S16_LE',
        '-r',
        String(SAMPLE_RATE),
        '-c',
        String(CHANNELS),
        '-t',
        'raw',
        '-q',
        '/dev/null',
      ])
    } catch (error) {
      resolve({ ok: false, stderr: String(error) })
      return
    }

    let settled = false
    let stderr = ''
    let timer: NodeJS.Timeout | null = null
    const finish = (result: ArecordProbeResult): void => {
      if (settled) return
      settled = true
      if (timer) runtime.clearTimeout(timer)
      resolve(result)
    }
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', error => {
      finish({ ok: false, stderr: String(error) })
    })
    child.once('close', code => {
      finish({ ok: code === 0, stderr: stderr.trim() })
    })
    timer = runtime.setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: true, stderr: '' })
    }, 150)
    timer.unref()
  })
}

function unavailable(
  environment: RecordingEnvironment,
  permission: PermissionState,
  errorCode: RecordingAvailability['errorCode'],
  errorMessage: string,
  guidance: string,
): AvailabilityInspection {
  return {
    status: {
      available: false,
      backend: null,
      permission,
      environment,
      errorCode,
      errorMessage,
      guidance,
    },
    addon: null,
  }
}

export async function inspectAvailability(
  options: RecorderOptions,
  runtime: RuntimeDependencies,
): Promise<AvailabilityInspection> {
  const wsl = await isWsl(runtime)
  const environment: RecordingEnvironment = options.remoteEnvironmentHint
    ? 'remote'
    : wsl
      ? 'wsl'
      : 'local'

  if (options.remoteEnvironmentHint) {
    return unavailable(
      environment,
      'unknown',
      'REMOTE_ENVIRONMENT',
      'Audio recording is disabled by the remote-environment hint.',
      'Run the recorder on the machine that owns the microphone, or remove the hint only when the server host has a usable microphone.',
    )
  }
  if (!SUPPORTED_PLATFORMS.has(runtime.platform)) {
    return unavailable(
      environment,
      'unknown',
      'UNSUPPORTED_PLATFORM',
      `Unsupported platform: ${runtime.platform}`,
      'Use Windows, Linux, or macOS.',
    )
  }
  if (!SUPPORTED_ARCHITECTURES.has(runtime.arch)) {
    return unavailable(
      environment,
      'unknown',
      'UNSUPPORTED_ARCHITECTURE',
      `Unsupported architecture: ${runtime.arch}`,
      'Use an arm64 or x64 Node.js process.',
    )
  }

  const addonPath =
    options.nativeAddonPath ??
    defaultNativeAddonPath(runtime.platform, runtime.arch)
  const loaded = runtime.loadNative(addonPath)
  const alsaUsable = await linuxHasAlsaCards(runtime)

  if (loaded.addon && alsaUsable) {
    let rawPermission: number | undefined
    try {
      rawPermission = loaded.addon.microphoneAuthorizationStatus?.()
    } catch {
      rawPermission = undefined
    }
    const permission = permissionState(rawPermission)
    if (permission === 'restricted') {
      return unavailable(
        environment,
        permission,
        'MICROPHONE_PERMISSION_RESTRICTED',
        'Microphone access is restricted by the operating system.',
        'Ask the device administrator to allow microphone access for Node.js.',
      )
    }
    if (permission === 'denied') {
      const guidance =
        runtime.platform === 'darwin'
          ? 'Open System Settings > Privacy & Security > Microphone and allow the application that launches Node.js.'
          : runtime.platform === 'win32'
            ? 'Open Windows Settings > Privacy & security > Microphone and allow desktop applications to use the microphone.'
            : 'Allow microphone access for the Node.js process.'
      return unavailable(
        environment,
        permission,
        'MICROPHONE_PERMISSION_DENIED',
        'Microphone access is denied.',
        guidance,
      )
    }
    return {
      status: {
        available: true,
        backend: 'native',
        permission,
        environment,
        errorCode: null,
        errorMessage: null,
        guidance: null,
      },
      addon: loaded.addon,
    }
  }

  if (runtime.platform === 'linux') {
    const probe = await probeArecord(runtime)
    if (probe.ok) {
      return {
        status: {
          available: true,
          backend: 'arecord',
          permission: 'unknown',
          environment,
          errorCode: null,
          errorMessage: null,
          guidance: null,
        },
        addon: loaded.addon,
      }
    }
    const detectedEnvironment: RecordingEnvironment = wsl ? 'wsl' : 'headless'
    const guidance = wsl
      ? 'Use WSL2 with WSLg on Windows 11, or run the recorder in native Windows. WSLg exposes audio through PulseAudio even when /proc/asound/cards is empty.'
      : 'Connect a capture device and install alsa-utils so `arecord` can open the default input.'
    return unavailable(
      detectedEnvironment,
      'unknown',
      'AUDIO_BACKEND_UNAVAILABLE',
      probe.stderr || loaded.error?.message || 'No usable Linux capture backend was found.',
      guidance,
    )
  }

  return unavailable(
    environment,
    'unknown',
    'NATIVE_ADDON_MISSING',
    loaded.error?.message ?? 'The native audio addon could not be loaded.',
    'Verify that the package contains the native binary matching this operating system and Node.js architecture.',
  )
}

let availabilityCache: Promise<RecordingAvailability> | null = null

export function checkDefaultAvailability(
  refresh = false,
): Promise<RecordingAvailability> {
  if (refresh || !availabilityCache) {
    const runtime = createRuntimeDependencies()
    availabilityCache = inspectAvailability({}, runtime).then(result => result.status)
  }
  return availabilityCache
}
