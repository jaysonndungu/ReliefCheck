import { fileURLToPath } from 'node:url'
import { loadEnv, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { API_PREFIX } from '@reliefcheck/contracts'

export default defineConfig(({ mode }) => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const { PORT = '3000' } = loadEnv(mode, repoRoot, 'PORT')

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { [API_PREFIX]: `http://127.0.0.1:${PORT}` },
    },
  }
})
