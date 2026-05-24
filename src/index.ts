import 'dotenv/config'
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { buildApp } from './app.js'

async function main() {
  const config = loadConfig()
  const pool = createPool(config)
  const app = await buildApp(config, pool)
  await app.listen({ port: config.port, host: '0.0.0.0' })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
