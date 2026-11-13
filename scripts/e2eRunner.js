const { spawnSync } = require('node:child_process');
const { createClient } = require('redis');
const net = require('node:net');
const crypto = require('node:crypto');

const REDIS_HOST = '127.0.0.1';
const REDIS_PORT = 16380;
const REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}`;
const BACKEND_PORT = 3100;
const IMAGE = 'redis:7.2-alpine';
const containerName = `redis-session-e2e-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
let ownsContainer = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.stdio || 'pipe', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout?.trim() || '';
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', (error) => reject(new Error(`E2E port ${port} is already in use (${error.code}); refusing to connect to an unknown service.`)));
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
}

async function waitForRedis() {
  const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 1000 } });
  client.on('error', () => {});
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      try {
        await client.connect();
        const info = await client.info('server');
        const version = info.match(/^redis_version:([^\r\n]+)/m)?.[1];
        if (!version?.startsWith('7.2.')) throw new Error(`Expected Redis 7.2, found ${version || 'unknown version'}`);
        const ping = await client.ping();
        if (ping !== 'PONG') throw new Error('Redis test PING did not return PONG');
        return version;
      } catch (error) {
        if (client.isOpen) await client.disconnect();
        if (/Expected Redis|PING/.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('Redis test container did not become ready within 15 seconds');
  } finally {
    if (client.isOpen) await client.quit();
  }
}

async function main() {
  await assertPortFree(REDIS_PORT);
  await assertPortFree(BACKEND_PORT);
  run('docker', ['image', 'inspect', IMAGE]);
  run('docker', [
    'run', '--detach', '--name', containerName,
    '--label', 'redis-session-app.e2e=true',
    '--publish', `${REDIS_HOST}:${REDIS_PORT}:6379`,
    IMAGE,
  ]);
  ownsContainer = true;
  const version = await waitForRedis();
  console.log(`E2E environment verified: Redis ${version} at ${REDIS_URL}; disposable container ${containerName}; no volume mounted.`);

  const cli = require.resolve('@playwright/test/cli');
  const requestedArgs = process.argv.slice(2);
  const runNodeTests = requestedArgs.includes('--with-node-tests');
  const args = requestedArgs.filter((argument) => argument !== '--with-node-tests');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    E2E_TEST: 'true',
    REDIS_URL,
    E2E_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
  };
  const failures = [];
  try { run(process.execPath, [cli, 'test', ...args], { stdio: 'inherit', env }); }
  catch (error) { failures.push(`Playwright: ${error.message}`); }
  if (runNodeTests) {
    try { run(process.execPath, ['--test'], { stdio: 'inherit', env: { ...env, REDIS_TEST_URL: REDIS_URL } }); }
    catch (error) { failures.push(`Node.js regression: ${error.message}`); }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

main().catch((error) => {
  console.error(`[e2e runner] ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  if (!ownsContainer) return;
  try {
    const inspect = spawnSync('docker', ['inspect', '--format', '{{ index .Config.Labels "redis-session-app.e2e" }}', containerName], { encoding: 'utf8' });
    if (inspect.status === 0 && inspect.stdout.trim() === 'true') {
      const result = spawnSync('docker', ['rm', '--force', containerName], { encoding: 'utf8' });
      if (result.status !== 0) {
        console.error(`[e2e runner] Could not remove its test Redis container ${containerName}: ${result.stderr || result.error?.message || 'unknown error'}`);
        process.exitCode = 1;
      } else console.log(`Removed disposable test Redis container ${containerName}.`);
    }
  } catch (error) {
    console.error(`[e2e runner] Cleanup failed for its test Redis container ${containerName}: ${error.message}`);
    process.exitCode = 1;
  }
});
