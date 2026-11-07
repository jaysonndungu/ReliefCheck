import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp, type AppDeps } from '../src/app.js'

export type TestServer = { url: string; close: () => Promise<void> }

export async function startServer(deps: Partial<AppDeps> = {}): Promise<TestServer> {
  const app = createApp({ readiness: null, staffAuth: null, webDist: null, ...deps })
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
