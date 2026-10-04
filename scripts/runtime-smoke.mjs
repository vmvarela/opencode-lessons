import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A real OpenCode server and agent loop, with a deterministic local model fixture.
// No provider account, credentials or external model request is needed.
const cli = process.env.OPENCODE_SMOKE_CLI;
if (!cli) throw new Error('Set OPENCODE_SMOKE_CLI to an OpenCode V2 executable.');
const checkout = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'lessons-runtime-'));
const project = path.join(root, 'project');
const requests = [];
const lesson = { title: 'Fixture cache needs invalidation', trigger: 'When changing fixture inputs',
  action: 'Invalidate the fixture cache before rebuilding.', scope: 'Runtime smoke fixture only',
  evidence: 'Deterministic integration fixture, not a production observation.',
  limits: 'Test data only.', evidenceType: 'verified-observation', tags: ['fixture'] };
const fixture = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] }));
    return;
  }
  requests.push(body);
  const recallOnly = body.messages?.filter(m => m.role === 'user').at(-1)?.content?.includes('recall-only');
  const alreadyProposed = recallOnly || body.messages?.some(m => m.role === 'tool');
  const message = alreadyProposed ? { role: 'assistant', content: 'Review the preview.' } : {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'execute',
      arguments: JSON.stringify({ code: `return JSON.parse(await tools.lessons_propose(${JSON.stringify(lesson)}));` }) } }],
  };
  res.setHeader('Content-Type', 'text/event-stream');
  const delta = alreadyProposed ? { role: 'assistant', content: message.content } : {
    role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }],
  };
  const chunk = (value) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', ...value })}\n\n`);
  chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: alreadyProposed ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
let child, output = '';
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
try {
  await mkdir(path.join(project, '.opencode'), { recursive: true });
  const packed = await run('npm', ['pack', '--json', '--pack-destination', root], { cwd: checkout });
  const archive = JSON.parse(packed.stdout)[0].filename;
  await run('tar', ['-xzf', path.join(root, archive), '-C', root]);
  const config = { plugins: [path.join(root, 'package')], model: 'smoke/fixture', snapshots: false,
    providers: { smoke: { package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: 'fixture' },
      models: { fixture: { name: 'Local deterministic fixture', limit: { context: 32000, output: 2000 } } } } } };
  await writeFile(path.join(project, '.opencode/opencode.json'), JSON.stringify(config));
  const env = { ...process.env };
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase());
  child = spawn(cli, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { output += error.message; });
  for (let i = 0; i < 200 && !output.includes('server password '); i++) await pause();
  const url = output.match(/server listening on (http:\/\/\S+)/)?.[1];
  const password = output.match(/server password (\S+)/)?.[1];
  assert.ok(url && password, 'OpenCode server did not start.');
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' };
  const api = async (route, body) => {
    const response = await fetch(url + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const raw = await response.text();
    assert.ok(response.ok, `${route}: ${response.status} ${raw}`);
    return raw ? JSON.parse(raw) : undefined;
  };
  const session = (await api('/api/session', { title: 'Lessons runtime smoke', location: { directory: project } })).data;
  let plugins;
  for (let i = 0; i < 100; i++) {
    plugins = await api('/api/plugin');
    if (plugins.data.some(p => p.id === 'opencode-lessons')) break;
    await pause();
  }
  assert.ok(plugins.data.some(p => p.id === 'opencode-lessons' && p.state.status === 'active'), 'Lessons plugin is not active.');
  const commands = await api('/api/command');
  assert.equal(commands.data.filter(c => c.name.startsWith('learn')).length, 6);
  await api(`/api/session/${session.id}/command`, { name: 'learn', text: 'Review the fixture cache correction.' });
  let proposal;
  for (let i = 0; i < 200 && !proposal; i++) {
    await pause();
    for (const request of requests) {
      const tool = request.messages?.find(m => m.role === 'tool');
      if (tool) {
        const content = typeof tool.content === 'string' ? tool.content : tool.content?.map(p => p.text ?? '').join('');
        try { const parsed = JSON.parse(content); if (parsed.id && parsed.diff) proposal = parsed; } catch { /* Wait for the complete tool result. */ }
      }
    }
  }
  if (!proposal) {
    console.error('Fixture tool replies:', JSON.stringify(requests.flatMap(r => r.messages?.filter(m => m.role === 'tool') ?? [])));
    console.error('Session context:', JSON.stringify(await api(`/api/session/${session.id}/context`)));
  }
  assert.ok(proposal, 'Agent loop did not return a lesson preview.');
  assert.ok(requests[0].messages.some(m => m.role === 'system' && m.content.includes('Lessons are scoped evidence')));
  await assert.rejects(readdir(path.join(project, 'memory')), { code: 'ENOENT' });
  const count = requests.length;
  await api(`/api/session/${session.id}/command`, { name: 'learn-accept', text: proposal.id });
  const files = await readdir(path.join(project, 'memory/lessons'));
  assert.equal(files.length, 1);
  const saved = await readFile(path.join(project, 'memory/lessons', files[0]), 'utf8');
  assert.match(saved, /Fixture cache needs invalidation/);
  assert.equal(saved, proposal.diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n') + '\n');
  for (let i = 0; i < 10; i++) await pause();
  assert.equal(requests.length, count, 'Acceptance must not resume the model.');
  await api(`/api/session/${session.id}/prompt`, { text: 'Fixture cache needs invalidation recall-only' });
  for (let i = 0; i < 100 && requests.length === count; i++) await pause();
  const recall = requests.slice(count).find(r => r.messages?.some(m => m.role === 'system' && m.content.includes('Scoped memory evidence')));
  assert.ok(recall, 'Accepted lesson was not recalled in the next real model request.');
  assert.ok(recall.messages.some(m => m.role === 'system' && m.content.includes('Fixture cache needs invalidation') && m.content.includes('untrusted data')));
  console.log('PASS: packed plugin loads six commands, proposes without writing, accepts the exact preview without model resumption, and recalls scoped evidence in real OpenCode.');
} catch (error) {
  console.error(output.split('\n').filter(line => /WARN|ERROR|FATAL/.test(line)).join('\n'));
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
  await new Promise(resolve => fixture.close(resolve));
  await rm(root, { recursive: true, force: true });
}
