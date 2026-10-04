import type { Server } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from './config/database.js';
import { EnvValidationError, loadEnv, type Env } from './config/env.js';
import { createLogger, type Logger } from './config/logger.js';
import { createContainer, type Container } from './container.js';

/** Registers SIGTERM/SIGINT handlers that drain work in a safe order, then exit. */
export function registerShutdown(
  logger: Logger,
  steps: { name: string; run: () => Promise<void> | void }[],
  onStart: () => void = () => undefined,
): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    onStart();
    logger.info({ signal }, 'Shutting down');
    let exitCode = 0;
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        exitCode = 1;
        logger.error({ err, step: step.name }, 'Shutdown step failed');
      }
    }
    logger.info('Shutdown complete');
    logger.flush();
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export async function bootstrap(): Promise<{ container: Container; server: Server }> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    // Fail fast with variable names only; values are never printed.
    process.stderr.write(`${err instanceof EnvValidationError ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const logger = createLogger(env);

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  await connectDatabase(env.MONGODB_URI, logger);
  const container = createContainer(env, logger);
  await ensureIndexes();

  const app = createApp(container);
  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ port: env.PORT, llmMode: env.PYTHON_LLM_MODE }, 'HTTP server listening');
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  if (env.WORKER_ENABLED) container.worker.start();

  registerShutdown(
    logger,
    [
      {
        name: 'http',
        run: () =>
          new Promise<void>((resolve) => {
            // Stop accepting connections; end SSE streams so keep-alive sockets can close.
            server.close(() => {
              resolve();
            });
            container.sseRegistry.closeAll();
            server.closeIdleConnections();
            setTimeout(() => {
              server.closeAllConnections();
            }, env.SHUTDOWN_GRACE_MS).unref();
          }),
      },
      { name: 'worker', run: () => container.worker.stop(env.SHUTDOWN_GRACE_MS) },
      { name: 'llm-client', run: () => container.llmClient.close() },
      { name: 'database', run: () => disconnectDatabase() },
    ],
    () => {
      container.lifecycle.shuttingDown = true;
    },
  );

  return { container, server };
}

await bootstrap();
