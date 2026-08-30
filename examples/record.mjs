#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkAvailability, createRecorder } from '@mixtint/audio-recorder-node'

const outputPath = resolve(process.cwd(), 'recording.mp3')
const availability = await checkAvailability({ refresh: true })

if (!availability.available) {
  console.error(availability.errorMessage ?? 'Audio recording is unavailable.')
  if (availability.guidance) console.error(availability.guidance)
  process.exitCode = 1
} else {
  const recorder = createRecorder()
  const started = await recorder.start()
  let stopping = false
  let progressActive = false

  console.log(`Recording with ${started.backend} capture. Press Ctrl+C to stop.`)
  const progressTimer = setInterval(() => {
    progressActive = true
    process.stdout.write(`\r${recorder.status().progress}`)
  }, 100)

  const stop = async () => {
    if (stopping) return
    stopping = true
    clearInterval(progressTimer)
    try {
      const mp3 = await recorder.stop(started.recordingID)
      await writeFile(outputPath, mp3)
      if (progressActive) process.stdout.write('\n')
      console.log(`Saved ${outputPath} (${recorder.status().progress}).`)
    } catch (error) {
      if (progressActive) process.stdout.write('\n')
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    } finally {
      await recorder.dispose()
    }
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  if (process.platform !== 'win32') process.once('SIGHUP', stop)
}
