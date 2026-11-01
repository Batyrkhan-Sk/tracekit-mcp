import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Demo application: a product catalog with a deliberate state-management
 * defect that makes the loading placeholder flash over already-rendered
 * content after every page load. See README.md in this folder.
 */

export type CatalogMode = 'buggy' | 'fixed';

export interface CatalogServerOptions {
  port?: number;
  host?: string;
  mode?: CatalogMode;
  /** Delay of the initial products response. */
  productsDelayMs?: number;
  /** Delay of the user-preferences response that triggers the re-sort. */
  preferencesDelayMs?: number;
  /** Delay of the sorted products response (the visible flicker duration in buggy mode). */
  resortDelayMs?: number;
}

export interface CatalogServer {
  url: string;
  port: number;
  mode: CatalogMode;
  close(): Promise<void>;
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const PRODUCTS = [
  { id: 1, name: 'Espresso cup', price: 12 },
  { id: 2, name: 'Travel mug', price: 24 },
  { id: 3, name: 'Mug rack', price: 36 },
  { id: 4, name: 'Pour-over kettle', price: 48 },
  { id: 5, name: 'Coffee scale', price: 30 },
  { id: 6, name: 'Bean grinder', price: 85 },
];

const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/catalog': 'index.html',
  '/catalog.js': 'catalog.js',
  '/styles.css': 'styles.css',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startCatalogServer(options: CatalogServerOptions = {}): Promise<CatalogServer> {
  const mode = options.mode ?? 'buggy';
  const productsDelay = options.productsDelayMs ?? 150;
  const preferencesDelay = options.preferencesDelayMs ?? 600;
  const resortDelay = options.resortDelayMs ?? 300;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        res.end(`window.CATALOG_CONFIG = ${JSON.stringify({ mode })};`);
        return;
      }
      if (url.pathname === '/api/products') {
        const sort = url.searchParams.get('sort');
        await sleep(sort ? resortDelay : productsDelay);
        const items = [...PRODUCTS];
        if (sort === 'price') items.sort((a, b) => a.price - b.price);
        else items.sort((a, b) => a.name.localeCompare(b.name));
        json(res, 200, { items, sort: sort ?? 'name' });
        return;
      }
      if (url.pathname === '/api/preferences') {
        await sleep(preferencesDelay);
        json(res, 200, { sort: 'price' });
        return;
      }
      if (url.pathname === '/api/banner') {
        // Intentional, harmless noise: an optional promo banner endpoint that does not exist.
        json(res, 404, { error: 'No active promotion' });
        return;
      }
      const file = STATIC_FILES[url.pathname];
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const body = await fs.readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// CLI: tsx examples/faulty-catalog-app/server.ts [--mode=buggy|fixed] [--port=4173]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const mode = (arg('mode') ?? process.env.CATALOG_MODE ?? 'buggy') as CatalogMode;
  if (mode !== 'buggy' && mode !== 'fixed') {
    console.error('--mode must be "buggy" or "fixed"');
    process.exit(1);
  }
  const app = await startCatalogServer({ mode, port: Number(arg('port') ?? process.env.PORT ?? 4173) });
  console.log(`Faulty catalog app (${app.mode}) listening on ${app.url}/catalog`);
  process.on('SIGINT', () => void app.close().then(() => process.exit(0)));
}
