import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import plugin from '../src/index.js';

const lesson = { title: 'Terraform owns branch protection', trigger: 'When updating rulesets', action: 'Edit the declared Terraform source.',
  scope: 'PrisaMedia workspace', evidence: 'Explicit user correction dated 2026-10-04.', limits: 'Not a policy for personal projects.', evidenceType: 'user-correction', tags: ['terraform'] };

export async function host(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lessons-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map(), commands = new Map(), hooks = new Map(), messages = [];
  let disposed = 0;
  const registration = () => ({ dispose: async () => { disposed++; } });
  const ctx = { options, location: { directory: root },
    tool: { transform: async fn => { fn({ add: tool => tools.set(tool.name, tool) }); return registration(); } },
    command: { transform: async fn => { fn({ add: cmd => commands.set(cmd.name, cmd) }); return registration(); } },
    session: { get: async ({ sessionID }) => ({ parentID: sessionID === 'child-a' ? 'session-a' : undefined, location: { directory: sessionID === 'foreign' ? os.tmpdir() : root } }),
      hook: async (name, fn) => { hooks.set(name, fn); return registration(); },
      prompt: async input => { messages.push(input); }, synthetic: async input => { messages.push(input); } } };
  const cleanup = await plugin.setup(ctx);
  const call = async (name, input = {}, sessionID = 'session-a') => JSON.parse((await tools.get(name).execute(input, { sessionID, signal: new AbortController().signal })).content);
  const command = (name, text = '', sessionID = 'session-a') => commands.get(name).execute({ sessionID, prompt: { text }, delivery: 'queue' });
  return { root, tools, commands, hooks, messages, call, command, cleanup, disposed: () => disposed };
}

test('registers four tools and six commands without a model or persistent client store', async t => {
  const h = await host(t);
  assert.equal(h.tools.size, 4);
  assert.equal(h.commands.size, 6);
  assert.equal(h.hooks.size, 1);
  assert.deepEqual(await readdir(h.root), []);
  await h.cleanup();
  assert.equal(h.disposed(), 3);
});

test('user accepts an exact preview once; proposal itself does not write', async t => {
  const h = await host(t);
  const proposal = await h.call('lessons_propose', lesson);
  assert.match(proposal.diff, /Terraform owns/);
  assert.deepEqual(await readdir(h.root), []);
  await h.command('learn-accept', proposal.id);
  assert.equal((await h.call('lessons_search', { query: 'Terraform protection' })).matches.length, 1);
  await assert.rejects(h.command('learn-accept', proposal.id), /No pending/);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].resume, false);
});

test('session isolation prevents accepting another session proposal or reading another project', async t => {
  const h = await host(t);
  const proposal = await h.call('lessons_propose', lesson);
  await assert.rejects(h.command('learn-accept', proposal.id, 'session-b'), /No pending/);
  await assert.rejects(h.call('lessons_search', { query: 'Terraform' }, 'foreign'), /another project/);
  const event = { sessionID: 'foreign', system: [], messages: [{ role: 'user', content: 'Terraform' }] };
  await h.hooks.get('context')(event);
  assert.deepEqual(event.system, []);
});

test('dismissal and plugin cleanup remove proposals', async t => {
  const h = await host(t);
  const first = await h.call('lessons_propose', lesson);
  await h.command('learn-dismiss', first.id);
  assert.equal(h.messages[0].resume, false);
  await assert.rejects(h.command('learn-accept', first.id), /No pending/);
  const second = await h.call('lessons_propose', lesson);
  await h.cleanup();
  await assert.rejects(h.command('learn-accept', second.id), /No pending/);
  assert.deepEqual(await readdir(h.root), []);
});

test('recall injects relevant bounded evidence with trust boundaries and uses latest user text', async t => {
  const h = await host(t, { autoRecall: true });
  await h.command('learn-accept', (await h.call('lessons_propose', lesson)).id);
  const event = { sessionID: 'session-a', system: [], messages: [{ role: 'assistant', content: 'unrelated' }, { role: 'user', content: [{ type: 'text', text: 'Terraform rulesets' }] }] };
  await h.hooks.get('context')(event);
  assert.equal(event.system.length, 2);
  assert.match(event.system[1].text, /untrusted data/);
  assert.match(event.system[1].text, /Terraform owns/);
  const other = { sessionID: 'session-a', system: [], messages: [{ role: 'user', content: 'xylophone' }] };
  await h.hooks.get('context')(other);
  assert.equal(other.system.length, 1);
});

test('autoRecall can be disabled without hiding tools or starting another model', async t => {
  const h = await host(t);
  await h.command('learn-accept', (await h.call('lessons_propose', lesson)).id);
  const event = { sessionID: 'session-a', system: [], messages: [{ role: 'user', content: 'Terraform' }] };
  await h.hooks.get('context')(event);
  assert.equal(event.system.length, 1);
  assert.equal((await h.call('lessons_search', { query: 'Terraform' })).matches.length, 1);
});

test('commands preserve delivery and attachments while requesting bounded learning', async t => {
  const h = await host(t);
  await h.commands.get('learn').execute({ sessionID: 'session-a', prompt: { text: 'This task', files: [{ uri: 'file:///reference' }] }, delivery: 'queue' });
  assert.equal(h.messages[0].delivery, 'queue');
  assert.equal(h.messages[0].files[0].uri, 'file:///reference');
  assert.match(h.messages[0].text, /at most three/);
  assert.deepEqual(await readdir(h.root), []);
});

test('bad options and V1 fail visibly rather than loading silently', async t => {
  await assert.rejects(plugin.setup({}), /V2/);
  await assert.rejects(host(t, { autoRecall: 'yes' }), /boolean/);
  await assert.rejects(host(t, { contextBudget: 0 }), /contextBudget/);
  await assert.rejects(host(t, { unknown: true }), /Unknown/);
});

test('promotion exposes context review through the tool and user command without writing context', async t => {
  const h = await host(t);
  const proposal = await h.call('lessons_propose', lesson);
  await h.command('learn-accept', proposal.id);
  const filesBefore = await readdir(h.root, { recursive: true });
  const plan = await h.call('lessons_promote', { id: proposal.id });
  assert.equal(plan.destinations.find(d => d.type === 'context').path, 'context/');
  assert.equal(plan.writes, false);
  assert.match(plan.deprecation, /Deprecated/);
  assert.match(h.commands.get('learn-promote').description, /DEPRECATED/);
  await h.command('learn-promote', proposal.id);
  const prompt = h.messages.at(-1).text;
  assert.match(prompt, /stable project facts in context\//);
  assert.match(prompt, /source of truth/);
  assert.match(prompt, /Do not apply changes/);
  assert.match(prompt, /explicit review approval/);
  assert.ok(prompt.includes(proposal.id));
  assert.deepEqual(await readdir(h.root, { recursive: true }), filesBefore);
});

test('cancelled tool work is rejected before scanning or proposing', async t => {
  const h = await host(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.tools.get('lessons_propose').execute(lesson, { sessionID: 'session-a', signal: controller.signal }));
  assert.deepEqual(await readdir(h.root), []);
});

test('Slim-style child proposals can be accepted from their parent, not from an unrelated root', async t => {
  const h = await host(t);
  const proposal = await h.call('lessons_propose', lesson, 'child-a');
  await assert.rejects(h.command('learn-accept', proposal.id, 'session-b'), /No pending/);
  await h.command('learn-accept', proposal.id, 'session-a');
  assert.equal((await h.call('lessons_search', { query: 'Terraform' })).matches.length, 1);
});
