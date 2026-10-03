import type { EchoApi } from '../shared/api'

declare global {
  interface Window {
    echo: EchoApi
  }
}
export {}
