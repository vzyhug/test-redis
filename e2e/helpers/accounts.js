const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const { createClient } = require('redis');

const E2E_REDIS_URL = 'redis://127.0.0.1:16380';
const TEST_PASSWORD = 'E2E-Only-Password-42!';

function connectTestRedis() {
  if (process.env.REDIS_URL !== E2E_REDIS_URL || process.env.E2E_TEST !== 'true') {
    throw new Error('Refusing E2E seed: only the disposable Redis at 127.0.0.1:16380 is allowed.');
  }
  const client = createClient({ url: E2E_REDIS_URL });
  client.on('error', () => {});
  return client;
}

async function seedAccount(client, role = 'USER') {
  const suffix = crypto.randomBytes(5).toString('hex');
  const userId = `e2e-${crypto.randomUUID()}`;
  const username = `e2e_${role.toLowerCase()}_${suffix}`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await client.hSet(`user:${userId}`, {
    username,
    passwordHash,
    role,
    email: `${username}@example.test`,
  });
  await client.set(`username:${username}`, userId);
  return { userId, username, password: TEST_PASSWORD, role };
}

async function withTestRedis(action) {
  const client = connectTestRedis();
  try {
    await client.connect();
    const info = await client.info('server');
    const version = info.match(/^redis_version:([^\r\n]+)/m)?.[1];
    if (!version?.startsWith('7.2.')) throw new Error(`Refusing E2E data access: expected Redis 7.2, found ${version || 'unknown'}`);
    return await action(client);
  } finally {
    if (client.isOpen) await client.quit();
  }
}

async function seedAccounts() {
  return withTestRedis(async (client) => ({
    user: await seedAccount(client, 'USER'),
    otherUser: await seedAccount(client, 'USER'),
    admin: await seedAccount(client, 'ADMIN'),
  }));
}

module.exports = { E2E_REDIS_URL, TEST_PASSWORD, connectTestRedis, withTestRedis, seedAccount, seedAccounts };
