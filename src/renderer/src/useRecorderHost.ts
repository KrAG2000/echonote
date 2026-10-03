import { useEffect, useRef, useState } from 'react'
import { Recorder, RecorderError } from './recorder'
import { api, useEvent } from './lib'

/**
 * Hosts the microphone recorder in the main window. It only reacts to commands from the main
 * process (RecordingController), which is what guarantees a single recording session.
 */
export function useRecorderHost(onToast: (level: 'info' | 'success' | 'error', msg: string) => void): {
  level: number
} {
  const recorder = useRef<Recorder | null>(null)
  const [level, setLevel] = useState(0)
  if (!recorder.current) recorder.current = new Recorder()

  useEffect(() => {
    const r = recorder.current!
    r.onLevel = setLevel
    r.onDeviceLost = () => {
      onToast('error', 'The microphone was disconnected. Saving what was recorded.')
      void api.stopRecording()
    }
    void api.recorderReady()
    return () => {
      void r.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEvent((e) => {
    if (e.type !== 'recorder-command') return
    const r = recorder.current!
    if (e.command === 'start') {
      r.start()
        .then(() => api.recorderStarted(Date.now()))
        .catch((err: unknown) => {
          const code = err instanceof RecorderError ? err.code : 'RECORDING_FAILED'
          const message = err instanceof Error ? err.message : 'Recording failed.'
          void api.recorderFailed(code, message)
          onToast('error', message)
        })
    } else if (e.command === 'stop') {
      if (!r.active) {
        void api.recorderFailed('RECORDING_FAILED', 'No active recording to stop.')
        return
      }
      r.stop()
        .then((res) => api.submitRecording(res))
        .then((res) => {
          if (res.ok) return
          if (res.error.code === 'INVALID_REQUEST')
            void api.recorderFailed('RECORDING_FAILED', 'The recording was rejected.')
          onToast(res.error.code === 'EMPTY_RECORDING' ? 'info' : 'error', res.error.message)
        })
        .catch((err: unknown) => {
          void api.recorderFailed('RECORDING_FAILED', (err as Error).message)
          onToast('error', 'The recording could not be finalized.')
        })
    } else if (e.command === 'cancel') {
      void r.cancel()
    }
  })

  return { level }
}
