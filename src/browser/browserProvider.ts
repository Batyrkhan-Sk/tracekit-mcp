import { chromium, type Browser } from 'playwright';
import type { Logger } from '../util/logger.js';

export interface BrowserProvider {
  /** Returns a connected browser and registers one user of it. */
  acquire(): Promise<Browser>;
  /** Unregisters a user; the browser is closed when nobody uses it. */
  release(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Launches a single Chromium instance lazily and shares it between
 * investigations. Each investigation gets its own BrowserContext (separate
 * cookies, storage, cache and proxy), never a persistent profile.
 */
export class ChromiumProvider implements BrowserProvider {
  private browser: Promise<Browser> | null = null;
  private users = 0;
  private closingIntentionally = new WeakSet<Browser>();

  constructor(private readonly options: { headless: boolean; logger: Logger }) {}

  async acquire(): Promise<Browser> {
    this.users += 1;
    try {
      if (!this.browser) this.browser = this.launch();
      const browser = await this.browser;
      if (!browser.isConnected()) {
        this.browser = this.launch();
        return await this.browser;
      }
      return browser;
    } catch (error) {
      this.users -= 1;
      this.browser = null;
      throw error;
    }
  }

  async release(): Promise<void> {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) await this.close();
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = null;
    if (!pending) return;
    try {
      const browser = await pending;
      this.closingIntentionally.add(browser);
      await browser.close();
    } catch (error) {
      this.options.logger.warn('browser close failed', { error: String(error) });
    }
  }

  private async launch(): Promise<Browser> {
    this.options.logger.info('launching chromium', { headless: this.options.headless });
    const browser = await chromium.launch({
      headless: this.options.headless,
      // Every context sets its own proxy. The launch-level placeholder makes a
      // context without a proxy fail closed instead of connecting directly.
      proxy: { server: 'http://per-context' },
      args: [
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--dns-prefetch-disable',
        '--disable-quic',
      ],
    });
    browser.on('disconnected', () => {
      if (!this.closingIntentionally.has(browser))
        this.options.logger.warn('browser disconnected unexpectedly');
    });
    return browser;
  }
}
