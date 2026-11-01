import { ChromiumProvider, type BrowserProvider } from '../../src/browser/browserProvider.js';
import type { InvestigatorConfig } from '../../src/config/config.js';
import { createInvestigator } from '../../src/server/createServer.js';
import { silentLogger } from '../../src/util/logger.js';
import { testConfig } from './config.js';

/** Counts browser acquisitions/releases so tests can assert that resources are returned. */
export class CountingProvider implements BrowserProvider {
  acquired = 0;
  released = 0;
  private readonly inner = new ChromiumProvider({ headless: true, logger: silentLogger });

  async acquire() {
    this.acquired++;
    return this.inner.acquire();
  }
  async release() {
    this.released++;
    return this.inner.release();
  }
  close() {
    return this.inner.close();
  }
}

export function realInvestigator(config: Partial<InvestigatorConfig>) {
  const provider = new CountingProvider();
  const cfg = testConfig({ maxConcurrentInvestigations: 4, maxRetainedInvestigations: 20, ...config });
  const investigator = createInvestigator(cfg, silentLogger, { provider });
  return { ...investigator, provider, config: cfg };
}
