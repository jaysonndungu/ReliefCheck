import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { API_PREFIX, LIVENESS_PATH, livenessSchema } from '@reliefcheck/contracts'
import './styles.css'

function App() {
  const [status, setStatus] = useState('Checking API connection...')

  useEffect(() => {
    const controller = new AbortController()

    async function checkApi() {
      try {
        const response = await fetch(`${API_PREFIX}${LIVENESS_PATH}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Health check failed')
        livenessSchema.parse(await response.json())
        setStatus('API connected')
      } catch {
        if (!controller.signal.aborted) {
          setStatus('API unavailable. Check your terminal and reload this page.')
        }
      }
    }

    void checkApi()
    return () => controller.abort()
  }, [])

  return (
    <main>
      <h1>ReliefCheck</h1>
      <p>Development starter for the disaster relief evidence app.</p>
      <p role="status">{status}</p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
