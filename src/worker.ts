/**
 * Standalone worker process: runs the review job worker without the HTTP server.
 * Use it to scale processing independently (set WORKER_ENABLED=false on API instances).
 * SSE clients connected to API instances receive events via database polling.
 */
import { connectDatabase, disconnectDatabase, ensureIndexes } from './config/database.js';
import { EnvValidationError, loadEnv, type Env } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createContainer } from './container.js';
import { startMetricsServer } from './infrastructure/metrics/metrics-server.js';

let env: Env;
try {
  env = loadEnv();
} catch (err) {
  process.stderr.write(`${err instanceof EnvValidationError ? err.message : String(err)}\n`);
  process.exit(1);
}
const logger = createLogger(env).child({ process: 'worker' });
await connectDatabase(env.MONGODB_URI, logger);
const container = createContainer(env, logger);
await ensureIndexes();
container.worker.start();
const metricsServer = container.metricsRegistry
  ? startMetricsServer(container.metricsRegistry, {
      host: env.METRICS_HOST,
      port: env.METRICS_PORT,
      logger,
    })
  : null;

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Worker shutting down');
  await container.worker.stop(env.SHUTDOWN_GRACE_MS);
  await container.llmClient.close();
  metricsServer?.close();
  await disconnectDatabase();
  logger.flush();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
