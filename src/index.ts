import 'dotenv/config'
import { loadConfig } from './config.js'
import { createHttpProxy } from './db/http-proxy.js'
import { createPool } from './db/pool.js'
import { buildApp } from './app.js'

async function main() {
  const config = loadConfig()

  const db = config.sakuraProxyUrl
    ? createHttpProxy(config.sakuraProxyUrl, config.sakuraProxyKey ?? '')
    : createPool(config)

  const app = await buildApp(config, db)
  await app.listen({ port: config.port, host: '0.0.0.0' })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
