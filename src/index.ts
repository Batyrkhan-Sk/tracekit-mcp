#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/config.js';
import { createInvestigator, createMcpServer } from './server/createServer.js';
import { createLogger } from './util/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { manager } = createInvestigator(config, logger);

  const removed = await manager.cleanupStaleArtifacts();
  if (removed) logger.info('removed stale artifact directories', { removed });

  const handle = serveStdio(() => createMcpServer(manager, logger), {
    onerror: (error) => logger.warn('transport error', { error: error.message }),
  });
  logger.info('frontend bug investigator listening on stdio', {
    allowedHosts: config.allowedHosts.length ? config.allowedHosts : 'any public host',
    allowedLocalOrigins: config.allowedLocalOrigins,
    artifactsDir: config.artifactsDir,
  });

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    try {
      await manager.dispose();
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
