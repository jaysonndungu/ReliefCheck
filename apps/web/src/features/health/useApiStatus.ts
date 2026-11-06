import { useCallback, useEffect, useRef, useState } from 'react'
import { API_PREFIX, LIVENESS_PATH, livenessSchema } from '@reliefcheck/contracts'

export type ApiStatus = 'checking' | 'waking' | 'connected' | 'unavailable'

/** Free hosting sleeps when idle and can take about a minute to wake (ai.md §2, §12). */
const ATTEMPT_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 15_000, 15_000]

async function checkOnce(signal: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_PREFIX}${LIVENESS_PATH}`, {
      signal: AbortSignal.any([signal, timeout]),
      cache: 'no-store',
    })
    if (!response.ok) return false
    return livenessSchema.safeParse(await response.json()).success
  } catch {
    return false
  }
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function useApiStatus() {
  const [status, setStatus] = useState<ApiStatus>('checking')
  const controllerRef = useRef<AbortController | null>(null)

  const run = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('checking')

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (await checkOnce(controller.signal)) {
        if (!controller.signal.aborted) setStatus('connected')
        return
      }
      if (controller.signal.aborted) return
      if (attempt === RETRY_DELAYS_MS.length) break
      setStatus('waking')
      await wait(RETRY_DELAYS_MS[attempt]!, controller.signal)
      if (controller.signal.aborted) return
    }
    setStatus('unavailable')
  }, [])

  useEffect(() => {
    void run()
    return () => controllerRef.current?.abort()
  }, [run])

  return { status, retry: run }
}
