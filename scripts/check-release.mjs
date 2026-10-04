// Offline checks only: never invoke publish, authentication or semantic-release.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const manifest = read('package.json');
const config = read('.releaserc.json');
assert.equal(manifest.name, 'opencode-lessons');
assert.equal(manifest.repository.url, 'git+https://github.com/vmvarela/opencode-lessons.git');
assert.equal(manifest.publishConfig.access, 'public');
assert.deepEqual(config.branches, ['master']);
assert.deepEqual(config.plugins.map(p => Array.isArray(p) ? p[0] : p), [
  '@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator', '@semantic-release/npm', '@semantic-release/github',
]);
assert.equal(config.plugins[2][1].npmPublish, true);

// pnpm keeps semantic-release's bundled plugins in its dependency scope.
const pluginRequire = createRequire(createRequire(path.join(root, 'package.json')).resolve('semantic-release'));
const load = name => import(pathToFileURL(pluginRequire.resolve(name)).href);
const logger = Object.fromEntries(['log', 'error', 'warn', 'info', 'success'].map(name => [name, () => {}]));
const { analyzeCommits } = await load('@semantic-release/commit-analyzer');
for (const [message, expected] of [
  ['fix: correct recall', 'patch'], ['feat: add context promotion', 'minor'],
  ['fix: change format\n\nBREAKING CHANGE: remove legacy memory', 'major'], ['docs: explain installation', null],
]) {
  assert.equal(await analyzeCommits({}, { commits: [{ message, hash: 'fixture' }], logger }), expected);
}
const npmPlugin = await load('@semantic-release/npm');
const githubPlugin = await load('@semantic-release/github');
assert.equal(typeof npmPlugin.publish, 'function');
assert.equal(typeof githubPlugin.publish, 'function');

const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
const expected = ['LICENSE', 'README.md', 'index.js', 'package.json', 'src/index.js', 'src/store.js'];
assert.deepEqual(pack.files.map(f => f.path).sort(), expected.sort());
assert.ok(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0, 'Plugin must retain zero runtime dependencies.');
console.log('PASS: release metadata, conventional commits, npm/GitHub plugins and six-file package verified offline.');
