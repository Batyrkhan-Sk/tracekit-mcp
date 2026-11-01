/**
 * Read-only health-check investigations of large public websites through the
 * real MCP server over stdio (two page views per site).
 * Usage: npm run build && npx tsx scripts/live-enterprise.ts [url ...]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { EvidenceItem } from '../src/types/evidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo-output', 'enterprise');

const DEFAULT_SITES = [
  'https://www.microsoft.com/en-us',
  'https://www.ibm.com/us-en',
  'https://www.salesforce.com/',
  'https://www.sap.com/',
  'https://www.oracle.com/',
  'https://www.atlassian.com/',
  'https://www.adobe.com/',
  'https://www.cisco.com/',
];

const ISSUE =
  'Health check: investigate uncaught JavaScript errors, console errors and failed network requests when the homepage loads and after a reload.';

type Result = { isError?: boolean; structuredContent?: unknown; content?: unknown };
const text = (r: Result) => ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n');

async function main() {
  const sites = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SITES;
  await fs.mkdir(OUT, { recursive: true });
  const client = new Client({ name: 'live-enterprise', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'dist', 'index.js')],
      env: {
        ...getDefaultEnvironment(),
        INVESTIGATOR_LOG_LEVEL: 'warn',
        INVESTIGATOR_ACTION_TIMEOUT_MS: '30000',
        INVESTIGATOR_ARTIFACTS_DIR: path.join(OUT, 'artifacts'),
      },
      stderr: 'inherit',
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;

  const summary: Record<string, unknown>[] = [];
  for (const url of sites) {
    const t0 = Date.now();
    console.log(`\n=== ${url}`);
    const started = await call('start_investigation', {
      targetUrl: url,
      issueDescription: ISSUE,
      maxDurationSeconds: 120,
    });
    if (started.isError) {
      console.log(`    start_investigation -> ${text(started)}`);
      summary.push({ url, error: text(started) });
      continue;
    }
    const s = started.structuredContent as {
      investigationId: string;
      navigation: { ok: boolean; status?: number; durationMs: number; error?: string; finalUrl: string };
    };
    const id = s.investigationId;
    console.log(
      `    navigation ok=${s.navigation.ok} status=${s.navigation.status ?? '-'} ${s.navigation.durationMs}ms -> ${s.navigation.finalUrl}${s.navigation.error ? ` (${s.navigation.error})` : ''}`,
    );

    const run = (
      await call('reproduce_issue', {
        investigationId: id,
        steps: [
          { action: 'reload', timeoutMs: 30000 },
          { action: 'screenshot', label: 'after reload' },
        ],
        continueOnFailure: true,
      })
    ).structuredContent as { steps: { description: string; status: string; error?: string }[] };
    for (const st of run.steps)
      console.log(`    step: ${st.status.padEnd(9)} ${st.description}${st.error ? ` (${st.error})` : ''}`);

    // Page through all evidence.
    const items: EvidenceItem[] = [];
    let since = 0;
    let counts: Record<string, number>;
    let dropped: Record<string, number>;
    for (;;) {
      const page = (await call('collect_evidence', { investigationId: id, sinceSeq: since, limit: 200 }))
        .structuredContent as {
        items: EvidenceItem[];
        nextSinceSeq: number;
        returnedCount: number;
        countsByType: Record<string, number>;
        droppedByType: Record<string, number>;
      };
      items.push(...page.items);
      counts = page.countsByType;
      dropped = page.droppedByType;
      if (page.returnedCount < 200) break;
      since = page.nextSinceSeq;
    }

    const pageErrors = items.filter((i) => i.type === 'page_error');
    const consoleErrors = items.filter((i) => i.type === 'console' && i.details.level === 'error');
    const httpErrors = items.filter(
      (i) => i.type === 'network_response' && !i.details.ok && !i.details.blockedByInvestigator,
    );
    const netFailures = items.filter((i) => i.type === 'network_failure' && !i.details.blockedByInvestigator);
    const security = items.filter((i) => i.type === 'security');
    const securityKinds: Record<string, number> = {};
    for (const s2 of security)
      if (s2.type === 'security')
        securityKinds[s2.details.reason] = (securityKinds[s2.details.reason] ?? 0) + 1;
    const injection = items.filter(
      (i) => (i.type === 'console' || i.type === 'page_error') && i.details.possiblePromptInjection,
    );

    console.log(
      `    evidence: ${items.length} items | page errors ${pageErrors.length} | console errors ${consoleErrors.length} | HTTP>=400 ${httpErrors.length} | network failures ${netFailures.length} | blocked by policy ${security.length} ${JSON.stringify(securityKinds)}`,
    );
    if (Object.keys(dropped).length) console.log(`    dropped (caps reached): ${JSON.stringify(dropped)}`);
    if (injection.length) console.log(`    possible prompt injection flagged: ${injection.length}`);
    for (const e of pageErrors.slice(0, 3))
      if (e.type === 'page_error')
        console.log(`    page error: ${e.details.name}: ${e.details.message.slice(0, 140)}`);
    for (const e of httpErrors.slice(0, 4))
      if (e.type === 'network_response')
        console.log(`    HTTP ${e.details.status} ${e.details.resourceType} ${e.url?.slice(0, 120)}`);
    for (const e of netFailures.slice(0, 3))
      if (e.type === 'network_failure')
        console.log(`    failed ${e.details.resourceType} ${e.url?.slice(0, 100)}: ${e.details.errorText}`);

    const analysis = (await call('analyze_evidence', { investigationId: id })).structuredContent as {
      reproduction: { status: string; matchedSymptoms: string[] };
      candidateRootCauses: { title: string; confidence: { level: string } }[];
    };
    console.log(
      `    reproduction: ${analysis.reproduction.status} [${analysis.reproduction.matchedSymptoms.join(', ')}]`,
    );
    for (const c of analysis.candidateRootCauses.slice(0, 4))
      console.log(`    cause: [${c.confidence.level}] ${c.title.slice(0, 130)}`);

    const host = new URL(url).hostname;
    const report = (await call('generate_bug_report', { investigationId: id })).structuredContent;
    await fs.writeFile(path.join(OUT, `${host}.report.json`), JSON.stringify(report, null, 2));
    const test = (await call('generate_regression_test', { investigationId: id })).structuredContent as {
      code: string;
      fileName: string;
    };
    await fs.writeFile(path.join(OUT, `${host}.${test.fileName}`), test.code);
    await call('close_investigation', { investigationId: id });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`    total ${seconds}s`);
    summary.push({
      url,
      status: s.navigation.status,
      reproduction: analysis.reproduction.status,
      pageErrors: pageErrors.length,
      httpErrors: httpErrors.length,
      blocked: security.length,
      evidence: items.length,
      counts,
      seconds,
    });
  }
  await fs.writeFile(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  await client.close();
  console.log(`\nReports, generated tests and screenshots: ${path.relative(ROOT, OUT)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
