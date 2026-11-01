/**
 * End-to-end demonstration:
 *   1. start the faulty catalog app (buggy mode)
 *   2. start the MCP server (dist/index.js) over stdio and connect an MCP client
 *   3. run an investigation, produce a bug report and a regression test
 *   4. run the generated test against the buggy app (expected: FAIL)
 *   5. restart the app in fixed mode and run the test again (expected: PASS)
 *
 * Usage: npm run demo   (add -- --update-sample to refresh examples/sample-investigation-report.json)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startCatalogServer, type CatalogServer } from '../examples/faulty-catalog-app/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo-output');
const PORT = Number(process.env.DEMO_PORT ?? 4173);
const updateSample = process.argv.includes('--update-sample');

const ISSUE =
  'After refreshing the catalog page, a loading placeholder briefly covers the content, and the page flickers before stabilizing.';

function heading(text: string) {
  console.log(`\n=== ${text} ${'='.repeat(Math.max(0, 70 - text.length))}`);
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    throw new Error(`${name} failed: ${text}`);
  }
  return result.structuredContent as T;
}

function runPlaywright(baseUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--config',
        'playwright.demo.config.ts',
      ],
      { cwd: ROOT, env: { ...process.env, BASE_URL: baseUrl }, stdio: 'inherit' },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'tests'), { recursive: true });

  heading('1. Starting faulty catalog app (buggy mode)');
  let app: CatalogServer = await startCatalogServer({ mode: 'buggy', port: PORT });
  console.log(`App: ${app.url}/catalog (mode=${app.mode})`);

  heading('2. Starting MCP server over stdio');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'dist', 'index.js')],
    env: {
      ...getDefaultEnvironment(),
      INVESTIGATOR_ALLOWED_LOCAL_ORIGINS: app.url,
      INVESTIGATOR_ARTIFACTS_DIR: path.join(OUT, 'artifacts'),
      INVESTIGATOR_LOG_LEVEL: 'warn',
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'demo-client', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`Discovered tools: ${tools.map((t) => t.name).join(', ')}`);

  heading('3. Investigation');
  const started = await call<{ investigationId: string; navigation: { ok: boolean; status?: number } }>(
    client,
    'start_investigation',
    {
      targetUrl: `${app.url}/catalog`,
      issueDescription: ISSUE,
      stepsToReproduce: [
        'Open the catalog page',
        'Refresh the page',
        'Watch the product grid while the page loads',
      ],
      watch: { loading: ['[data-testid="catalog-loading"]'], content: ['[data-testid="catalog-grid"]'] },
      waitUntil: 'networkidle',
      maxDurationSeconds: 120,
    },
  );
  const id = started.investigationId;
  console.log(
    `start_investigation -> ${id}, initial navigation ok=${started.navigation.ok} status=${started.navigation.status}`,
  );

  const reproduced = await call<{ summary: Record<string, number> }>(client, 'reproduce_issue', {
    investigationId: id,
    steps: [
      { action: 'reload', waitUntil: 'networkidle' },
      { action: 'waitFor', target: { by: 'testId', testId: 'catalog-grid' } },
      { action: 'screenshot', label: 'after refresh' },
    ],
  });
  console.log(`reproduce_issue -> ${JSON.stringify(reproduced.summary)}`);

  const evidence = await call<{ timeline: { elapsedMs: number; summary: string }[] }>(
    client,
    'collect_evidence',
    {
      investigationId: id,
      categories: [
        'navigation',
        'network_request',
        'network_response',
        'dom_visibility',
        'console',
        'page_error',
      ],
      limit: 200,
    },
  );
  console.log('collect_evidence timeline (excerpt):');
  for (const entry of evidence.timeline.filter((e) => !e.summary.includes('(heuristic)')).slice(0, 40)) {
    console.log(`  +${String(Math.round(entry.elapsedMs)).padStart(5)}ms  ${entry.summary}`);
  }

  const analysis = await call<{
    reproduction: { status: string; basis: string };
    candidateRootCauses: { id: string; title: string; confidence: { level: string; explanation: string } }[];
  }>(client, 'analyze_evidence', { investigationId: id });
  console.log(`analyze_evidence -> reproduction: ${analysis.reproduction.status}`);
  console.log(`  basis: ${analysis.reproduction.basis}`);
  for (const cause of analysis.candidateRootCauses) {
    console.log(`  ${cause.id} [${cause.confidence.level}] ${cause.title}`);
  }

  heading('4. Bug report');
  const report = await call<{ title: string; exportPath?: string }>(client, 'generate_bug_report', {
    investigationId: id,
  });
  const reportPath = path.join(OUT, 'bug-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Title: ${report.title}`);
  console.log(`Report written to ${path.relative(ROOT, reportPath)} (server export: ${report.exportPath})`);
  if (updateSample) {
    const sample = JSON.parse(
      JSON.stringify(report).replaceAll(ROOT.replaceAll('\\', '\\\\'), '<repo>').replaceAll(ROOT, '<repo>'),
    );
    await fs.writeFile(
      path.join(ROOT, 'examples', 'sample-investigation-report.json'),
      `${JSON.stringify(sample, null, 2)}\n`,
    );
    console.log('Updated examples/sample-investigation-report.json');
  }

  heading('5. Regression test');
  const generated = await call<{
    fileName: string;
    code: string;
    assertions: { description: string }[];
    assumptions: string[];
  }>(client, 'generate_regression_test', { investigationId: id });
  const testPath = path.join(OUT, 'tests', generated.fileName);
  await fs.writeFile(testPath, generated.code);
  console.log(`Test written to ${path.relative(ROOT, testPath)}`);
  generated.assertions.forEach((a) => console.log(`  asserts: ${a.description}`));

  await call(client, 'close_investigation', { investigationId: id });
  await client.close();

  heading('6. Generated test vs. BUGGY app (expected to fail)');
  const buggyExit = await runPlaywright(app.url);
  await app.close();

  heading('7. Generated test vs. FIXED app (expected to pass)');
  app = await startCatalogServer({ mode: 'fixed', port: PORT });
  const fixedExit = await runPlaywright(app.url);
  await app.close();

  heading('Result');
  const failedBefore = buggyExit !== 0;
  const passedAfter = fixedExit === 0;
  console.log(`Reproduction status: ${analysis.reproduction.status}`);
  console.log(`Regression test before fix: ${failedBefore ? 'FAILED (as expected)' : 'PASSED (unexpected)'}`);
  console.log(`Regression test after fix:  ${passedAfter ? 'PASSED (as expected)' : 'FAILED (unexpected)'}`);
  if (analysis.reproduction.status !== 'reproduced' || !failedBefore || !passedAfter) {
    console.error('Demo did not behave as expected.');
    process.exit(1);
  }
  console.log('Demo completed successfully.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
