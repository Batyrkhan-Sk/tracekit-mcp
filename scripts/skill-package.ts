import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Validation and zipping for agent-skill packages (SKILL.md format), following
 * the marketplace rules: kebab-case `name` equal to the folder name, a
 * `description`, text files only, no bundled dependencies, < 50 MB and < 1,000 files.
 */

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 1000;
const ALLOWED_EXTENSIONS = new Set(['.md', '.json', '.toml', '.yaml', '.yml', '.txt']);
const FORBIDDEN_DIRS = new Set(['node_modules', 'site-packages', '.venv', 'venv', '.git', '__pycache__']);

export interface SkillFile {
  /** Path inside the skill folder, with forward slashes. */
  relativePath: string;
  absolutePath: string;
  size: number;
}

export interface SkillValidation {
  name: string | null;
  files: SkillFile[];
  problems: string[];
}

export function listFiles(root: string, dir = root, problems: string[] = []): SkillFile[] {
  const out: SkillFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.has(entry.name))
        problems.push(`Bundled dependency or VCS folder is not allowed: ${relativePath}/`);
      else out.push(...listFiles(root, absolutePath, problems));
    } else if (entry.isFile()) {
      out.push({ relativePath, absolutePath, size: fs.statSync(absolutePath).size });
    } else {
      problems.push(`Unsupported entry (symlink or special file): ${relativePath}`);
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function parseFrontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.trim();
  }
  return fields;
}

export function validateSkill(skillDir: string): SkillValidation {
  const problems: string[] = [];
  const folderName = path.basename(path.resolve(skillDir));
  const files = listFiles(skillDir, skillDir, problems);
  const skillMd = path.join(skillDir, 'SKILL.md');
  let name: string | null = null;

  if (!fs.existsSync(skillMd)) {
    problems.push('SKILL.md is missing');
    return { name, files, problems };
  }
  const text = fs.readFileSync(skillMd, 'utf8');
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter) {
    problems.push('SKILL.md must start with YAML frontmatter between --- lines');
  } else {
    name = frontmatter.name ?? null;
    if (!name) problems.push('Frontmatter field "name" is required');
    else {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
        problems.push(`"name" must be lowercase letters, numbers and hyphens: ${name}`);
      if (name !== folderName) problems.push(`"name" (${name}) must match the folder name (${folderName})`);
    }
    const description = frontmatter.description ?? '';
    if (!description) problems.push('Frontmatter field "description" is required');
    const sentences = description.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length;
    if (sentences > 3) problems.push(`"description" should be one to three sentences (found ${sentences})`);
  }

  // Every references/… or assets/… path mentioned in SKILL.md must exist.
  for (const [, ref] of text.matchAll(/`((?:references|assets)\/[^`\s]+)`/g)) {
    if (!fs.existsSync(path.join(skillDir, ref!)))
      problems.push(`SKILL.md references a missing file: ${ref}`);
  }

  for (const file of files) {
    const ext = path.extname(file.relativePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext))
      problems.push(`File type not allowed in a skill package: ${file.relativePath}`);
  }
  if (files.length >= MAX_FILES) problems.push(`Too many files: ${files.length} (limit ${MAX_FILES - 1})`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total >= MAX_BYTES) problems.push(`Package too large: ${total} bytes (limit 50 MB)`);

  return { name, files, problems };
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Writes a standard deflate-compressed zip with every file under `<prefix>/`. */
export function writeZip(files: SkillFile[], prefix: string, outFile: string, now = new Date()): void {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${prefix}/${file.relativePath}`, 'utf8');
    const data = fs.readFileSync(file.absolutePath);
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...locals, ...centrals, end]));
}

/** Reads back the entries of a zip written by {@link writeZip} (used by tests). */
export function readZipEntries(zipFile: string): Map<string, Buffer> {
  const buf = fs.readFileSync(zipFile);
  const entries = new Map<string, Buffer>();
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8);
    const crc = buf.readUInt32LE(pos + 14);
    const compressedSize = buf.readUInt32LE(pos + 18);
    const nameLength = buf.readUInt16LE(pos + 26);
    const extraLength = buf.readUInt16LE(pos + 28);
    const name = buf.toString('utf8', pos + 30, pos + 30 + nameLength);
    const start = pos + 30 + nameLength + extraLength;
    const raw = buf.subarray(start, start + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (zlib.crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    entries.set(name, data);
    pos = start + compressedSize;
  }
  return entries;
}
