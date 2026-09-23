const assert = require('node:assert/strict');
const {execFileSync, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const prefix = process.env.CLEANUP_PREFIX;
assert.match(prefix || '', /^cleanup-smoke-[0-9]+-[0-9]+-[0-9]+$/);
const topology = process.env.CLEANUP_TOPOLOGY;
assert.ok(['root', 'tenant'].includes(topology));
const authDir = path.join(process.env.RUNNER_TEMP, `${prefix}-auth`);
const containers = [...(topology === 'tenant' ? [`${prefix}-dynamic`] : []), `${prefix}-static`];
const network = `${prefix}-net`;
const volume = `${prefix}-data`;
const holder = `${prefix}-volume-holder`;
const image = 'ghcr.io/ydb-platform/local-ydb:26.1.1.6';
const summary = path.join(process.env.RUNNER_TEMP, `${prefix}-cleanup.md`);
const docker = (...args) => execFileSync('docker', args, {encoding: 'utf8', timeout: 60_000}).trim();
const names = (kind) => docker(kind, 'ls', ...(kind === 'container' ? ['--all'] : []),
  '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}').split('\n');

function post(expected) {
  const result = spawnSync(process.execPath, [path.resolve('dist/post/index.js')], {
    encoding: 'utf8', timeout: 300_000,
    env: {...process.env, GITHUB_STEP_SUMMARY: summary, STATE_cleanup: 'true',
      STATE_topology: topology, STATE_staticContainer: `${prefix}-static`,
      STATE_dynamicContainer: topology === 'tenant' ? `${prefix}-dynamic` : '',
      STATE_network: network, STATE_volume: volume, STATE_authDir: authDir}
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.equal(fs.existsSync(authDir), false);
  if (expected === 1) assert.match(result.stdout, /Cleanup could not be verified/);
}

function assertAbsent() {
  for (const name of [...containers, holder]) assert.ok(!names('container').includes(name), name);
  assert.ok(!names('network').includes(network));
  assert.ok(!names('volume').includes(volume));
}

try {
  for (const name of containers) assert.ok(names('container').includes(name), `Setup did not create ${name}`);
  assert.ok(names('network').includes(network));
  assert.ok(names('volume').includes(volume));
  post(0);
  assertAbsent();
  post(0);
  assertAbsent();
  console.log('Bundled post cleanup verified on the running topology; repeated cleanup passed.');

  docker('network', 'create', network);
  docker('volume', 'create', volume);
  for (const name of containers) docker('create', '--name', name, '--network', network,
    '--mount', `type=volume,source=${volume},target=/fixture`, '--entrypoint', '/bin/sh', image, '-c', 'true');
  docker('create', '--name', holder, '--mount', `type=volume,source=${volume},target=/fixture`,
    '--entrypoint', '/bin/sh', image, '-c', 'true');
  fs.mkdirSync(authDir, {recursive: true});
  fs.writeFileSync(path.join(authDir, 'fixture'), 'cleanup proof');
  post(1);
  assert.ok(names('volume').includes(volume));
  assert.ok(names('container').includes(holder));
  for (const name of containers) assert.ok(!names('container').includes(name));
  assert.ok(!names('network').includes(network));
  docker('rm', '-f', holder);
  post(0);
  assertAbsent();
  console.log('Busy volume correctly failed cleanup; other resources were cleaned; recovery passed.');
} finally {
  for (const name of [...containers, holder]) spawnSync('docker', ['rm', '-f', name], {timeout: 60_000});
  spawnSync('docker', ['network', 'rm', network], {timeout: 60_000});
  spawnSync('docker', ['volume', 'rm', volume], {timeout: 60_000});
  fs.rmSync(authDir, {recursive: true, force: true});
  fs.rmSync(summary, {force: true});
  assertAbsent();
}
