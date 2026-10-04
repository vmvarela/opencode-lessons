import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LessonStore, validateLesson } from '../src/store.js';

export const lesson = { title: 'Use Linux Node for Playwright in WSL', trigger: 'When Playwright MCP times out in WSL',
  action: 'Run the server through nvm-exec and select Chromium.', scope: 'OpenCode V2 on Ubuntu WSL with nvm',
  evidence: 'Verified startup test on 2026-10-04; run reference test-42.', limits: 'Not tested on native Windows or without nvm.', evidenceType: 'verified-observation', tags: ['wsl', 'playwright'] };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lessons-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new LessonStore(root) };
}

test('proposal is read-only, acceptance produces readable Markdown and survives restart', async t => {
  const { root, store } = await fixture(t);
  const proposal = await store.propose(lesson);
  await assert.rejects(access(path.join(root, 'memory')));
  assert.match(proposal.diff, /\+## Evidence/);
  await store.accept(proposal);
  assert.match(await readFile(path.join(root, proposal.file), 'utf8'), /## Limits/);
  const result = await new LessonStore(root).search('Playwright WSL');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].id, proposal.id);
});

test('search includes existing legacy Markdown without rewriting it', async t => {
  const { root, store } = await fixture(t);
  await mkdir(path.join(root, 'memory'));
  const text = '# Lessons\n\n## Entry template\n```markdown\n### L-template — Terraform\n```\n\n## Log\n### L-20261004-001 — Terraform owns branch protection\n**Status:** resolved\nUse Terraform for rulesets in PrisaMedia.\n';
  await writeFile(path.join(root, 'memory/devops-lessons.md'), text);
  const result = await store.search('Terraform protection');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].managed, false);
  assert.match(result.matches[0].title, /Terraform owns/);
  assert.equal(await readFile(path.join(root, 'memory/devops-lessons.md'), 'utf8'), text);
});

test('scope-aware duplicate is rejected and another scope remains independent', async t => {
  const { store } = await fixture(t);
  await store.accept(await store.propose(lesson));
  assert.equal((await store.propose(lesson)).duplicate, true);
  assert.equal((await store.propose({ ...lesson, scope: 'A different repository' })).duplicate, undefined);
});

test('rejects tampered proposals and never overwrites an existing file', async t => {
  const { store, root } = await fixture(t);
  const proposal = await store.propose(lesson);
  await assert.rejects(store.accept({ ...proposal, content: proposal.content + 'tampered' }), /changed/);
  await mkdir(path.join(root, 'memory/lessons'), { recursive: true });
  await writeFile(path.join(root, proposal.file), 'Existing human content');
  await assert.rejects(store.accept(proposal), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(root, proposal.file), 'utf8'), 'Existing human content');
  assert.equal((await readdir(path.join(root, 'memory/lessons'))).length, 1);
});

test('rechecks duplicates that appear between preview and acceptance', async t => {
  const { store } = await fixture(t);
  const a = await store.propose(lesson);
  const b = await store.propose(lesson);
  await store.accept(a);
  await assert.rejects(store.accept(b), /duplicate/);
});

test('rejects symlinked memory directories without writing outside the project', async t => {
  const { store, root } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lessons-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const proposal = await store.propose(lesson);
  await symlink(outside, path.join(root, 'memory'), 'dir');
  await assert.rejects(store.accept(proposal), /Linked/);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(store.search('WSL'), /Linked/);
});

test('ignores symlinked files and never traverses projects or hidden directories', async t => {
  const { store, root } = await fixture(t);
  await mkdir(path.join(root, 'memory/.private'), { recursive: true });
  await writeFile(path.join(root, 'outside.md'), '## WSL secret\nDo not read.');
  await symlink(path.join(root, 'outside.md'), path.join(root, 'memory/external.md'));
  await writeFile(path.join(root, 'memory/.private/ignored.md'), '## WSL private\nDo not read.');
  assert.equal((await store.search('WSL')).matches.length, 0);
});

test('bounded search skips oversized and malformed managed files with coverage warnings', async t => {
  const { store, root } = await fixture(t);
  await mkdir(path.join(root, 'memory'));
  await writeFile(path.join(root, 'memory/large.md'), 'x'.repeat(300000));
  await writeFile(path.join(root, 'memory/bad.md'), '---\nopencode_lessons: 1\nid: broken\n---\n');
  const result = await store.search('anything');
  assert.equal(result.warnings.length, 2);
  assert.equal(result.matches.length, 0);
});

test('superseded lessons are excluded from recall and cannot be promoted', async t => {
  const { root, store } = await fixture(t);
  const proposal = await store.propose(lesson);
  await store.accept(proposal);
  const filename = path.join(root, proposal.file);
  await writeFile(filename, (await readFile(filename, 'utf8')).replace('state: "recorded"', 'state: "superseded"'));
  assert.equal((await store.search('WSL')).matches.length, 0);
  assert.equal((await store.review()).superseded.length, 1);
  await assert.rejects(store.promote(proposal.id), /superseded/);
});

test('promotion distinguishes context facts, instructions and skills without changing project files', async t => {
  const { store, root } = await fixture(t);
  const proposal = await store.propose(lesson);
  await store.accept(proposal);
  await mkdir(path.join(root, 'context'));
  const contextFile = path.join(root, 'context/platform.md');
  const context = '# Platform\n\nExisting project facts.\n';
  await writeFile(contextFile, context);
  const filesBefore = await readdir(root, { recursive: true });
  const before = await readFile(path.join(root, proposal.file), 'utf8');
  const plan = await store.promote(proposal.id);
  assert.equal(plan.writes, false);
  assert.equal(plan.lesson.id, proposal.id);
  assert.deepEqual(plan.destinations.map(d => d.type), ['context', 'instruction', 'skill']);
  assert.match(plan.destinations.find(d => d.type === 'context').purpose, /stable project facts/);
  assert.match(plan.steps.join(' '), /source of truth/);
  assert.match(plan.steps.join(' '), /duplicates and contradictions/);
  assert.match(plan.steps.join(' '), /explicit review approval/);
  assert.equal(await readFile(contextFile, 'utf8'), context);
  assert.deepEqual(await readdir(root, { recursive: true }), filesBefore);
  assert.equal(await readFile(path.join(root, proposal.file), 'utf8'), before);
});

test('validates evidence, boundaries, tags and likely credentials without echoing them', () => {
  assert.throws(() => validateLesson({ ...lesson, evidence: '' }), /evidence/);
  assert.throws(() => validateLesson({ ...lesson, evidenceType: 'guess' }), /evidence/);
  assert.throws(() => validateLesson({ ...lesson, action: 'Test\n## Scope\nInjected' }), /boundary/);
  assert.throws(() => validateLesson({ ...lesson, tags: ['bad tag'] }), /Tags/);
  assert.throws(() => validateLesson({ ...lesson, action: 'ghp_abcdefghijklmnopqrstuvwx' }), /Possible credential/);
  assert.throws(() => new LessonStore('/tmp', { directory: '../escape' }), /relative/);
  assert.throws(() => new LessonStore('/tmp', { directory: '/absolute' }), /relative/);
});

test('search obeys output budget and does not return irrelevant lessons', async t => {
  const { store } = await fixture(t);
  await store.accept(await store.propose(lesson));
  const found = await store.search('WSL', 5, 64);
  assert.ok(JSON.stringify(found).length <= 64);
  assert.equal(found.omitted, 1);
  assert.equal((await store.search('unrelatedxylophone')).matches.length, 0);
});

test('concurrent stores cannot write duplicate lessons', async t => {
  const { store, root } = await fixture(t);
  const second = new LessonStore(root);
  const a = await store.propose(lesson), b = await second.propose(lesson);
  const results = await Promise.allSettled([store.accept(a), second.accept(b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.search('WSL')).matches.length, 1);
});

test('legacy recall redacts common credential patterns', async t => {
  const { store, root } = await fixture(t);
  await mkdir(path.join(root, 'memory'));
  await writeFile(path.join(root, 'memory/old.md'), '## Terraform auth\nOld ghp_abcdefghijklmnopqrstuvwx token, api_key=abcdefgh12345.');
  const result = await store.search('Terraform auth');
  assert.match(result.matches[0].snippet, /redacted/);
  assert.doesNotMatch(JSON.stringify(result), /abcdefghijklmnopqrstuvwx|abcdefgh12345/);
});

test('unknown managed format is a coverage warning, not an empty success', async t => {
  const { store, root } = await fixture(t);
  await mkdir(path.join(root, 'memory'));
  await writeFile(path.join(root, 'memory/future.md'), '---\nopencode_lessons: 2\n---\n# Future\n');
  const found = await store.search('Future');
  assert.equal(found.warnings.length, 1);
});


test('retrieval ranks scope and tolerates reordered wording while rejecting generic overlap', async t => {
  const { store } = await fixture(t);
  const first = await store.propose(lesson); await store.accept(first);
  const other = await store.propose({ ...lesson, scope: 'Debian CI with nvm' }); await store.accept(other);
  assert.equal((await store.search('Ubuntu WSL Playwright hangs')).matches[0].id, first.id);
  assert.equal((await store.search('Playwright Debian CI')).matches[0].id, other.id);
  assert.equal((await store.search('How should I use this for the project')).matches.length, 0);
  assert.equal((await store.search('unrelated Windows photography')).matches.length, 0);
});

test('long lessons preserve complete boundaries or return an explicit read reference', async t => {
  const { store } = await fixture(t);
  await store.accept(await store.propose({ ...lesson, action: 'Careful action. '.repeat(100) }));
  const small = await store.search('Playwright WSL', 3, 600);
  assert.equal(small.matches[0].needsRead, true);
  assert.equal(small.matches[0].action, undefined);
  assert.ok(JSON.stringify(small).length <= 600);
  const full = await store.search('Playwright WSL', 3, 4000);
  assert.equal(full.matches[0].limits, lesson.limits);
  assert.equal(full.matches[0].evidence, lesson.evidence);
  assert.equal(full.matches[0].scope, lesson.scope);
});

test('the budget includes warning text and metadata', async t => {
  const { root, store } = await fixture(t);
  await mkdir(path.join(root, 'memory'));
  for (let i = 0; i < 15; i++) await writeFile(path.join(root, 'memory', `bad-${i}.md`), '---\nopencode_lessons: 2\n---\n');
  const result = await store.search('anything', 3, 200);
  assert.ok(JSON.stringify(result).length <= 200);
  assert.ok(result.omitted > 0);
});
