import type { RecorderErrorCode } from './types.js'

export class RecorderError extends Error {
  readonly code: RecorderErrorCode

  constructor(code: RecorderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RecorderError'
    this.code = code
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
