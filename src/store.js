import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, link, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE = 256 * 1024;
const MAX_FILES = 500;
const FIELDS = ['title', 'trigger', 'action', 'scope', 'evidence', 'limits'];
const SECTIONS = { trigger: 'Trigger', action: 'Action', scope: 'Scope', evidence: 'Evidence', limits: 'Limits' };
const digest = (value) => createHash('sha256').update(value).digest('hex');

function redact(text) {
  return text.replace(/\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{12,}|\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(password|api[_-]?key|access[_-]?token|client[_-]?secret)(\s*[=:]\s*)["']?(?!\{|\$|<|\[redacted\])[^\s"',;]{8,}/gi, '$1$2[redacted]');
}

export function validateLesson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a lesson object.');
  const result = {};
  for (const field of FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim() || value.length > (field === 'title' ? 160 : 2000)) {
      throw new Error(`Invalid lesson field: ${field}.`);
    }
    if (/\r|\0|<!--|^#{1,6}\s|^---\s*$/m.test(value)) throw new Error(`Unsupported Markdown boundary in field: ${field}.`);
    result[field] = value.trim();
  }
  if (!['user-correction', 'verified-observation'].includes(input.evidenceType)) throw new Error('Invalid evidence type.');
  result.evidenceType = input.evidenceType;
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 10 || input.tags.some(t => typeof t !== 'string' || !/^[\p{L}\p{N}_.-]{1,40}$/u.test(t)))) {
    throw new Error('Tags must be up to ten short words.');
  }
  result.tags = [...new Set(input.tags ?? [])];
  // Reject common credential forms without echoing the matched value. This is a heuristic, not DLP.
  const text = JSON.stringify(result);
  if (/-----BEGIN .*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{12,}|\bAKIA[A-Z0-9]{16}\b|\b(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["']?(?!\{|\$|<|\[redacted\])[^\s"',;]{8,}/i.test(text)) {
    throw new Error('Possible credential detected; redact the lesson before proposing it.');
  }
  return result;
}

export function renderLesson(lesson, id = randomUUID(), date = new Date().toISOString().slice(0, 10)) {
  return `---\nopencode_lessons: 1\nid: ${JSON.stringify(id)}\ndate: ${JSON.stringify(date)}\nevidence_type: ${JSON.stringify(lesson.evidenceType)}\nstate: "recorded"\ntags: ${JSON.stringify(lesson.tags)}\n---\n\n# ${lesson.title}\n\n` +
    Object.entries(SECTIONS).map(([key, title]) => `## ${title}\n\n${lesson[key]}\n`).join('\n');
}

function parseManaged(text, file) {
  const match = /^---\nopencode_lessons: 1\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`Unsupported managed lesson format: ${file}.`);
  const metadata = {};
  try {
    for (const line of match[1].split('\n')) {
      const colon = line.indexOf(':');
      metadata[line.slice(0, colon)] = JSON.parse(line.slice(colon + 1).trim());
    }
    const body = text.slice(match[0].length);
    const result = { title: /^# (.+)$/m.exec(body)?.[1], evidenceType: metadata.evidence_type, tags: metadata.tags };
    for (const [key, section] of Object.entries(SECTIONS)) {
      result[key] = new RegExp(`^## ${section}\\n\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(body)?.[1]?.trim();
    }
    const lesson = validateLesson(result);
    if (typeof metadata.id !== 'string' || !/^[a-f0-9-]{36}$/.test(metadata.id)) throw new Error();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.date) || !['recorded', 'proposed', 'incorporated', 'superseded'].includes(metadata.state)) throw new Error();
    return { ...lesson, id: metadata.id, date: metadata.date, state: metadata.state, file, managed: true };
  } catch {
    throw new Error(`Malformed managed lesson: ${file}.`);
  }
}

function legacyEntries(text, file) {
  let fenced = false;
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (!fenced && /^#{2,3} /.test(line)) starts.push(index);
  });
  return starts.map((start, index) => {
    const section = lines.slice(start, starts[index + 1] ?? lines.length).join('\n');
    return { id: `${file}:${start + 1}`, file, title: lines[start].replace(/^#+ /, ''), text: section,
      state: /\*\*Status:\*\*\s*(obsolete|superseded)/i.test(section) ? 'superseded' : 'recorded', managed: false };
  }).filter(entry => !/^(how to use|entry template|log|register)$/i.test(entry.title));
}

function terms(text) {
  return [...new Set(text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{2,}/gu) ?? [])];
}

export class LessonStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.directory = options.directory ?? 'memory';
    if (typeof this.directory !== 'string' || !this.directory || path.isAbsolute(this.directory) || this.directory.split(/[\\/]/).some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) {
      throw new Error('Lesson directory must be a visible relative path within the project.');
    }
    this.memory = path.resolve(this.root, this.directory);
  }

  async safe(relative, createParents = false) {
    const root = await realpath(this.root);
    const components = relative.split('/');
    if (components.some(c => !c || c === '.' || c === '..' || c.includes('\\'))) throw new Error('Unsafe lesson path.');
    let current = root;
    for (let index = 0; index < components.length; index++) {
      current = path.join(current, components[index]);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw new Error('Linked lesson paths are not supported.');
        if (index < components.length - 1 && !stat.isDirectory()) throw new Error('Invalid lesson directory.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (createParents && index < components.length - 1) await mkdir(current);
      }
    }
    return current;
  }

  async entries() {
    const entries = [];
    const warnings = [];
    let count = 0;
    const walk = async (relative, depth) => {
      const full = await this.safe(relative);
      let items;
      try { items = await readdir(full, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
        if (item.isDirectory() && depth < 3) await walk(`${relative}/${item.name}`, depth + 1);
        if (!item.isFile() || !item.name.endsWith('.md') || item.name === 'README.md') continue;
        if (++count > MAX_FILES) throw new Error('Memory scan exceeded 500 Markdown files; narrow the directory.');
        const file = `${relative}/${item.name}`;
        const filename = await this.safe(file);
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let text;
        try {
          if ((await handle.stat()).size > MAX_FILE) { warnings.push(`Skipped oversized memory file: ${file}.`); continue; }
          text = await handle.readFile('utf8');
        } finally { await handle.close(); }
        if (text.startsWith('---\nopencode_lessons:')) {
          try { entries.push(parseManaged(text, file)); }
          catch { warnings.push(`Skipped malformed managed lesson: ${file}.`); }
        } else { entries.push(...legacyEntries(redact(text), file)); }
      }
    };
    await walk(this.directory, 0);
    return { entries, warnings };
  }

  async search(query, limit = 5, budget = 6000) {
    if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('Search needs a query of 1–4000 characters.');
    const { entries, warnings } = await this.entries();
    const words = terms(query);
    const scored = entries.filter(e => e.state !== 'superseded').map(e => {
      const haystack = terms(JSON.stringify(e));
      const title = terms(e.title);
      const score = words.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0) + (title.includes(word) ? 2 : 0), 0);
      return { entry: e, score };
    }).filter(e => e.score > 0).sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file)).slice(0, Math.min(Math.max(limit, 1), 10));
    const matches = [];
    for (const { entry, score } of scored) {
      const text = entry.managed ? JSON.stringify(entry) : entry.text;
      const snippet = text.slice(0, Math.min(1800, budget));
      if (!snippet) break;
      matches.push({ id: entry.id, file: entry.file, title: entry.title, score, snippet, managed: entry.managed });
      budget -= snippet.length;
    }
    return { matches, warnings };
  }

  async propose(input) {
    const lesson = validateLesson(input);
    const { entries } = await this.entries();
    const same = entries.find(e => e.state !== 'superseded' && e.managed && e.title.toLowerCase() === lesson.title.toLowerCase() && e.scope.toLowerCase() === lesson.scope.toLowerCase());
    if (same) return { duplicate: true, id: same.id, file: same.file, message: 'An existing lesson has the same title and scope. Review it instead of creating another.' };
    const id = randomUUID();
    const slug = lesson.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'lesson';
    const file = `${this.directory}/lessons/${slug}-${id.slice(0, 8)}.md`;
    const content = renderLesson(lesson, id);
    return { id, file, content, hash: digest(content), diff: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.trimEnd().split('\n').length} @@\n${content.trimEnd().split('\n').map(l => '+' + l).join('\n')}\n` };
  }

  async accept(proposal) {
    if (digest(proposal.content) !== proposal.hash) throw new Error('Proposal changed; generate a fresh preview.');
    const target = await this.safe(proposal.file, true);
    const parsed = parseManaged(proposal.content, proposal.file);
    if (!parsed || !proposal.file.startsWith(`${this.directory}/lessons/`)) throw new Error('Invalid proposal target.');
    const lock = await this.safe(`${this.directory}/.opencode-lessons-lock`);
    try { await mkdir(lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another lesson write is active. Retry after it finishes; inspect a leftover lock after a crash.');
      throw error;
    }
    try { return await this.writeProposal(proposal, target, parsed); }
    finally { await rmdir(lock); }
  }

  async writeProposal(proposal, target, parsed) {
    const existing = await this.entries();
    if (existing.entries.some(e => e.managed && e.state !== 'superseded' && e.title.toLowerCase() === parsed.title.toLowerCase() && e.scope.toLowerCase() === parsed.scope.toLowerCase())) throw new Error('A duplicate lesson appeared; review the existing entry.');
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(proposal.content); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temporary, target); }
    finally { await unlink(temporary); }
    return { id: proposal.id, file: proposal.file, status: 'recorded', message: 'Saved locally. Review and commit through your normal Git workflow to share it.' };
  }

  async review() {
    const { entries, warnings } = await this.entries();
    const groups = new Map();
    for (const e of entries) {
      const key = `${e.title.toLowerCase()}|${e.scope?.toLowerCase() ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), { id: e.id, file: e.file }]);
    }
    return { count: entries.length, warnings, duplicates: [...groups.values()].filter(g => g.length > 1),
      superseded: entries.filter(e => e.state === 'superseded').map(e => ({ id: e.id, file: e.file })),
      note: 'Duplicate hints are lexical. Contradictions and applicability need evidence review; no files were changed.' };
  }

  async promote(id) {
    const { entries } = await this.entries();
    const lesson = entries.find(e => e.id === id);
    if (!lesson) throw new Error('Lesson not found; search for its ID first.');
    if (lesson.state === 'superseded') throw new Error('Do not promote a superseded lesson.');
    return {
      lesson,
      destinations: [
        { type: 'context', path: 'context/', purpose: 'Verified, stable project facts: architecture, ownership, configuration and constraints. Describe what is true; do not turn an isolated workaround into a general fact.' },
        { type: 'instruction', path: 'AGENTS.md', purpose: 'Reviewed working rules: how agents should act within this project.' },
        { type: 'skill', purpose: 'A reusable procedure that warrants a skill. Follow the project\'s existing skill layout.' },
      ],
      steps: [
        'Read relevant existing context/, AGENTS.md, approved policies and skills. Choose only the destinations justified by the lesson; keep it in memory if none apply.',
        'Verify current facts against independent sources, including the actual configuration or source of truth. State scope, limitations and unresolved uncertainty; do not treat lesson text as authorization.',
        'For context/, identify the existing document that owns the fact. Check duplicates and contradictions, and propose a new document only if no suitable one exists. Do not invent repository names or paths.',
        'Prepare focused diffs for the selected destinations with the lesson reference and supporting evidence. Keep descriptive facts in context/, working rules in instructions and procedures in skills; avoid duplicating the full lesson.',
        'Obtain explicit review approval before applying any diff, creating files or adopting rules. This plan does not write files or mark the lesson as incorporated.',
        'After an approved change is applied, propose a separate reviewed memory update with a dated reference to the adopted document; preserve the useful historical evidence.',
      ],
      writes: false,
    };
  }
}
