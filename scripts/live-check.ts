/**
 * Runs the MCP server (dist/index.js) against real public websites.
 * Usage: npm run build && npx tsx scripts/live-check.ts
 * Reports are written to demo-output/live/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo-output', 'live');

type Result = { isError?: boolean; structuredContent?: unknown; content?: unknown };
const text = (r: Result) => ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n');

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const client = new Client({ name: 'live-check', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist', 'index.js')],
      env: {
        ...getDefaultEnvironment(),
        INVESTIGATOR_LOG_LEVEL: 'warn',
        INVESTIGATOR_ARTIFACTS_DIR: path.join(OUT, 'artifacts'),
      },
      stderr: 'inherit',
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;

  async function investigate(
    label: string,
    start: Record<string, unknown>,
    steps: Record<string, unknown>[] = [],
  ) {
    console.log(`\n=== ${label}\n    ${start.targetUrl}`);
    const started = await call('start_investigation', { maxDurationSeconds: 120, ...start });
    if (started.isError) {
      console.log(`    start_investigation -> ERROR ${text(started)}`);
      return;
    }
    const s = started.structuredContent as {
      investigationId: string;
      navigation: { ok: boolean; status?: number };
    };
    console.log(`    navigation ok=${s.navigation.ok} status=${s.navigation.status ?? '-'}`);
    if (steps.length) {
      const run = (
        await call('reproduce_issue', { investigationId: s.investigationId, steps, continueOnFailure: true })
      ).structuredContent as { steps: { description: string; status: string; error?: string }[] };
      for (const st of run.steps)
        console.log(`    step: ${st.status.padEnd(9)} ${st.description}${st.error ? ` (${st.error})` : ''}`);
    }
    const analysis = (await call('analyze_evidence', { investigationId: s.investigationId }))
      .structuredContent as {
      reproduction: { status: string; matchedSymptoms: string[] };
      observedFacts: { statement: string }[];
      candidateRootCauses: { title: string; confidence: { level: string } }[];
    };
    console.log(
      `    reproduction: ${analysis.reproduction.status} [${analysis.reproduction.matchedSymptoms.join(', ')}]`,
    );
    for (const f of analysis.observedFacts.slice(0, 8)) console.log(`    fact:  ${f.statement}`);
    for (const c of analysis.candidateRootCauses.slice(0, 4))
      console.log(`    cause: [${c.confidence.level}] ${c.title}`);
    const security = (
      await call('collect_evidence', { investigationId: s.investigationId, categories: ['security'] })
    ).structuredContent as { timeline: { summary: string }[] };
    for (const e of security.timeline) console.log(`    security: ${e.summary}`);
    const report = (await call('generate_bug_report', { investigationId: s.investigationId }))
      .structuredContent;
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await fs.writeFile(path.join(OUT, `${slug}.report.json`), JSON.stringify(report, null, 2));
    const test = (await call('generate_regression_test', { investigationId: s.investigationId }))
      .structuredContent as {
      fileName: string;
      code: string;
    };
    await fs.writeFile(path.join(OUT, `${slug}.${test.fileName}`), test.code);
    await call('close_investigation', { investigationId: s.investigationId });
  }

  const site = 'https://the-internet.herokuapp.com';

  await investigate('JS error on load', {
    targetUrl: `${site}/javascript_error`,
    issueDescription: 'The page throws an uncaught JavaScript error when it loads.',
  });

  await investigate('Broken images', {
    targetUrl: `${site}/broken_images`,
    issueDescription: 'Some product images fail to load and show as broken.',
  });

  await investigate(
    'Dynamic loading (control, no bug expected)',
    {
      targetUrl: `${site}/dynamic_loading/2`,
      issueDescription: 'After clicking Start, the loading bar flickers or the content never appears.',
      watch: { loading: ['#loading'], content: ['#finish'] },
    },
    [
      { action: 'click', target: { by: 'role', role: 'button', name: 'Start' } },
      { action: 'waitFor', target: { by: 'text', text: 'Hello World!' }, timeoutMs: 15000 },
      { action: 'screenshot', label: 'after start' },
    ],
  );

  await investigate('Clean page (control)', {
    targetUrl: 'https://example.com/',
    issueDescription: 'The page shows an uncaught JavaScript error.',
  });

  // SSRF checks with real DNS: public hostnames that resolve to private/metadata addresses.
  await investigate('SSRF: public name resolving to loopback', {
    targetUrl: 'http://localtest.me/',
    issueDescription: 'x',
  });
  await investigate('SSRF: public name resolving to cloud metadata', {
    targetUrl: 'http://169.254.169.254.nip.io/latest/meta-data/',
    issueDescription: 'x',
  });
  await investigate(
    'SSRF: redirect from a public site to cloud metadata',
    { targetUrl: 'https://example.com/', issueDescription: 'The page fails to load after a redirect.' },
    [
      {
        action: 'navigate',
        url: 'https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F',
      },
    ],
  );

  await client.close();
  console.log(`\nReports and generated tests: ${path.relative(ROOT, OUT)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
