import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppStatus, Capture, ListQuery, PushEvent, Result, Settings } from '../../shared/types'

export const api = window.echo

export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code })
  return r.data
}

export function useEvent(cb: (e: PushEvent) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => api.onEvent((e) => ref.current(e)), [])
}

export function useStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null)
  useEffect(() => {
    void api.getStatus().then((r) => r.ok && setStatus(r.data))
  }, [])
  useEvent((e) => {
    if (e.type === 'status') setStatus(e.status)
  })
  return status
}

export function useSettings(): [Settings | null, (s: Settings) => void] {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api.getSettings().then((r) => r.ok && setSettings(r.data))
  }, [])
  return [settings, setSettings]
}

/** Captures for a view; refreshes whenever the main process reports a change. */
export function useCaptures(q: ListQuery): { items: Capture[]; loading: boolean; reload: () => void } {
  const [items, setItems] = useState<Capture[]>([])
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(q)
  const reload = useCallback(() => {
    void api.listCaptures(JSON.parse(key)).then((r) => {
      if (r.ok) setItems(r.data)
      setLoading(false)
    })
  }, [key])
  useEffect(() => {
    setLoading(true)
    reload()
  }, [reload])
  useEvent((e) => {
    if (e.type === 'captures-changed') reload()
  })
  return { items, loading, reload }
}

export function fmtDue(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function fmtAgo(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** ISO instant -> value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export const fmtMB = (b: number): string =>
  b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.round(b / 1024 / 1024)} MB`

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
