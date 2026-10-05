import type { Server } from 'node:http';
import express, { type Express } from 'express';
import type { Registry } from 'prom-client';
import type { Logger } from '../../config/logger.js';

/**
 * A separate, internal-only listener for Prometheus scrapes. Keeping /metrics off the public
 * API port means it is never reachable through the gateway, CORS or rate limiting.
 */
export function createMetricsApp(registry: Registry): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType).send(await registry.metrics());
  });
  app.use((_req, res) => {
    res.status(404).end();
  });
  return app;
}

export function startMetricsServer(
  registry: Registry,
  options: { host: string; port: number; logger: Logger },
): Server {
  const server = createMetricsApp(registry).listen(options.port, options.host, () => {
    options.logger.info({ port: options.port }, 'Metrics server listening');
  });
  server.on('error', (err) => options.logger.error({ err }, 'Metrics server error'));
  return server;
}
