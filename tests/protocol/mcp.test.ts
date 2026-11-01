import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvestigationManager } from '../../src/investigations/manager.js';
import { EgressPolicy } from '../../src/security/egressPolicy.js';
import { createMcpServer } from '../../src/server/createServer.js';
import {
  AnalyzeEvidenceOutput,
  CollectEvidenceOutput,
  GenerateBugReportOutput,
  GenerateRegressionTestOutput,
  ReproduceIssueOutput,
  StartInvestigationOutput,
} from '../../src/tools/schemas.js';
import { silentLogger } from '../../src/util/logger.js';
import { testConfig } from '../helpers/config.js';
import { fakeSessionFactory, publicResolver } from '../helpers/fakeSession.js';

type TextBlock = { type: string; text?: string };
const textOf = (result: { content?: unknown }) =>
  ((result.content ?? []) as TextBlock[]).map((c) => c.text ?? '').join('\n');

const EXPECTED_TOOLS = [
  'start_investigation',
  'reproduce_issue',
  'collect_evidence',
  'analyze_evidence',
  'generate_bug_report',
  'generate_regression_test',
  'close_investigation',
];

describe('MCP protocol (in-memory transport)', () => {
  let client: Client;
  let manager: InvestigationManager;

  beforeEach(async () => {
    const { factory } = fakeSessionFactory();
    manager = new InvestigationManager({
      config: testConfig(),
      policy: new EgressPolicy({ allowedHosts: [], allowedLocalOrigins: [], resolve: publicResolver }),
      createSession: factory,
      logger: silentLogger,
    });
    const server = createMcpServer(manager, silentLogger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'protocol-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await manager.dispose({ removeArtifacts: true });
  });

  it('advertises all tools with input and output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
    const start = tools.find((t) => t.name === 'start_investigation')!;
    expect(start.inputSchema.required).toEqual(expect.arrayContaining(['targetUrl', 'issueDescription']));
    expect(start.annotations?.openWorldHint).toBe(true);
    expect(tools.find((t) => t.name === 'analyze_evidence')!.annotations?.readOnlyHint).toBe(true);
  });

  it('rejects malformed input before the handler runs', async () => {
    const missing = await client.callTool({
      name: 'start_investigation',
      arguments: { targetUrl: 'https://example.com' },
    });
    expect(missing.isError).toBe(true);
    const badAction = await client.callTool({
      name: 'reproduce_issue',
      arguments: {
        investigationId: 'inv_00000000-0000-4000-8000-000000000000',
        steps: [{ action: 'evaluate', script: 'alert(1)' }],
      },
    });
    expect(badAction.isError).toBe(true);
    const badId = await client.callTool({
      name: 'collect_evidence',
      arguments: { investigationId: '../../secrets' },
    });
    expect(badId.isError).toBe(true);
    expect(manager.list()).toEqual([]);
  });

  it('returns structured tool errors with stable codes', async () => {
    const rejected = await client.callTool({
      name: 'start_investigation',
      arguments: { targetUrl: 'http://169.254.169.254/latest/meta-data/', issueDescription: 'x' },
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toMatch(/^URL_REJECTED: /);

    const missing = await client.callTool({
      name: 'analyze_evidence',
      arguments: { investigationId: 'inv_00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^NOT_FOUND: /);
  });

  it('runs the full tool flow with schema-valid structured results', async () => {
    const started = await client.callTool({
      name: 'start_investigation',
      arguments: {
        targetUrl: 'https://shop.example.com/catalog',
        issueDescription: 'The loading spinner flickers after refresh',
        watch: { loading: ['.spinner'], content: ['.grid'] },
      },
    });
    expect(started.isError).toBeFalsy();
    const start = StartInvestigationOutput.parse(started.structuredContent);
    const id = start.investigationId;
    // Text content mirrors the structured result for clients that only read text.
    expect(JSON.parse(textOf(started))).toEqual(started.structuredContent);

    const reproduced = await client.callTool({
      name: 'reproduce_issue',
      arguments: {
        investigationId: id,
        steps: [
          { action: 'reload' },
          { action: 'click', target: { by: 'role', role: 'button', name: 'More' } },
        ],
      },
    });
    expect(ReproduceIssueOutput.parse(reproduced.structuredContent).summary.succeeded).toBe(2);

    const collected = await client.callTool({
      name: 'collect_evidence',
      arguments: { investigationId: id, categories: ['action'], limit: 1 },
    });
    const evidence = CollectEvidenceOutput.parse(collected.structuredContent);
    expect(evidence.returnedCount).toBe(1);
    expect(evidence.matchingCount).toBe(2);

    const page2 = CollectEvidenceOutput.parse(
      (
        await client.callTool({
          name: 'collect_evidence',
          arguments: { investigationId: id, categories: ['action'], sinceSeq: evidence.nextSinceSeq },
        })
      ).structuredContent,
    );
    expect(page2.items.map((i) => i.id)).not.toContain(evidence.items[0]!.id);

    const analysis = AnalyzeEvidenceOutput.parse(
      (
        await client.callTool({
          name: 'analyze_evidence',
          arguments: { investigationId: id, additionalContext: 'Recent change to the sort preferences' },
        })
      ).structuredContent,
    );
    expect(analysis.llmUsed).toBe(false);
    expect(analysis.clientContext).toBe('Recent change to the sort preferences');

    const report = GenerateBugReportOutput.parse(
      (await client.callTool({ name: 'generate_bug_report', arguments: { investigationId: id } }))
        .structuredContent,
    );
    expect(report.investigationId).toBe(id);

    const test = GenerateRegressionTestOutput.parse(
      (
        await client.callTool({
          name: 'generate_regression_test',
          arguments: { investigationId: id, testName: 'catalog stays stable' },
        })
      ).structuredContent,
    );
    expect(test.executed).toBe(false);
    expect(test.code).toContain("test('catalog stays stable'");

    const closed = await client.callTool({ name: 'close_investigation', arguments: { investigationId: id } });
    expect(closed.structuredContent).toMatchObject({ investigationId: id, state: 'closed' });

    const afterClose = await client.callTool({
      name: 'reproduce_issue',
      arguments: { investigationId: id, steps: [{ action: 'reload' }] },
    });
    expect(afterClose.isError).toBe(true);
    expect(textOf(afterClose)).toMatch(/^INVALID_STATE: /);
  });

  it('rejects unknown tools', async () => {
    const result = await client
      .callTool({ name: 'execute_javascript', arguments: { code: '1' } })
      .catch((error: Error) => error);
    if (result instanceof Error) expect(result.message).toMatch(/tool|not found/i);
    else expect(result.isError).toBe(true);
  });
});

describe('MCP protocol (stdio transport)', () => {
  it('serves tools over stdio, writes nothing but protocol to stdout, and exits when the client disconnects', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.join(root, 'src', 'index.ts')],
      cwd: root,
      env: { ...getDefaultEnvironment(), INVESTIGATOR_LOG_LEVEL: 'error' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('frontend-bug-investigator');
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(EXPECTED_TOOLS.length);
      const result = await client.callTool({
        name: 'start_investigation',
        arguments: { targetUrl: 'http://127.0.0.1:1/', issueDescription: 'x' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/URL_REJECTED/);
    } finally {
      const pid = transport.pid;
      await client.close();
      // The server must exit once stdin closes.
      const deadline = Date.now() + 10_000;
      while (pid && Date.now() < deadline && isAlive(pid)) await new Promise((r) => setTimeout(r, 100));
      expect(pid && isAlive(pid)).toBeFalsy();
    }
  }, 60_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
