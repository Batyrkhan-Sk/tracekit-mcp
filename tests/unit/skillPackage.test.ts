import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readZipEntries, validateSkill, writeZip } from '../../scripts/skill-package.js';

const SKILL_DIR = path.resolve(import.meta.dirname, '..', '..', 'skills', 'frontend-bug-investigator');
const temp: string[] = [];

function tempSkill(name: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  temp.push(root);
  const dir = path.join(root, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('frontend-bug-investigator skill', () => {
  it('passes package validation', () => {
    const result = validateSkill(SKILL_DIR);
    expect(result.problems).toEqual([]);
    expect(result.name).toBe('frontend-bug-investigator');
    expect(result.files.map((f) => f.relativePath)).toContain('SKILL.md');
  });

  it('only names tools the MCP server actually provides', () => {
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const named = new Set(
      [...text.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]!).filter((n) => n.includes('_')),
    );
    const tools = [
      'start_investigation',
      'reproduce_issue',
      'collect_evidence',
      'analyze_evidence',
      'generate_bug_report',
      'generate_regression_test',
      'close_investigation',
    ];
    for (const tool of tools) expect(named.has(tool), tool).toBe(true);
  });

  it('round-trips through the zip writer', () => {
    const { files } = validateSkill(SKILL_DIR);
    const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-zip-')), 'skill.zip');
    temp.push(path.dirname(zip));
    writeZip(files, 'frontend-bug-investigator', zip);
    const entries = readZipEntries(zip);
    expect(entries.size).toBe(files.length);
    for (const file of files) {
      expect(
        entries
          .get(`frontend-bug-investigator/${file.relativePath}`)
          ?.equals(fs.readFileSync(file.absolutePath)),
      ).toBe(true);
    }
  });
});

describe('validateSkill', () => {
  it('rejects a name that does not match the folder or is not kebab-case', () => {
    const dir = tempSkill('my-skill', {
      'SKILL.md': '---\nname: My_Skill\ndescription: Does a thing.\n---\n# x\n',
    });
    const { problems } = validateSkill(dir);
    expect(problems.some((p) => p.includes('lowercase'))).toBe(true);
    expect(problems.some((p) => p.includes('must match the folder'))).toBe(true);
  });

  it('rejects missing frontmatter fields', () => {
    const dir = tempSkill('a-skill', { 'SKILL.md': '# no frontmatter\n' });
    expect(validateSkill(dir).problems[0]).toMatch(/frontmatter/);
  });

  it('rejects bundled dependencies, binaries and dangling references', () => {
    const dir = tempSkill('a-skill', {
      'SKILL.md': '---\nname: a-skill\ndescription: Does a thing.\n---\nSee `references/missing.md`.\n',
      'node_modules/x/index.js': '',
      'assets/tool.exe': 'MZ',
    });
    const { problems } = validateSkill(dir);
    expect(problems.some((p) => p.includes('node_modules'))).toBe(true);
    expect(problems.some((p) => p.includes('tool.exe'))).toBe(true);
    expect(problems.some((p) => p.includes('references/missing.md'))).toBe(true);
  });
});
