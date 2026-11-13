// ============================================================
// seedUsers.js - Tạo 2 user mẫu trong Redis
// Chạy: npm run seed   (chạy nhiều lần vẫn an toàn - ghi đè cùng key)
// ============================================================
const bcrypt = require('bcrypt');
const { client, connectRedis } = require('../src/redisClient');

const users = [
  {
    userId: '1001',
    username: 'nguyenvana',
    password: '123456',
    role: 'USER',
    email: 'nguyenvana@gmail.com',
  },
  {
    userId: '1002',
    username: 'tranthib',
    password: '123456',
    role: 'ADMIN',
    email: 'tranthib@gmail.com',
  },
];

async function seed() {
  try {
    await connectRedis();

    for (const u of users) {
      // Không lưu plain text: băm mật khẩu bằng bcrypt
      const passwordHash = await bcrypt.hash(u.password, 10);

      // HSET user:<userId> ...
      await client.hSet(`user:${u.userId}`, {
        username: u.username,
        passwordHash: passwordHash,
        role: u.role,
        email: u.email,
      });

      // SET username:<username> <userId>
      await client.set(`username:${u.username}`, u.userId);

      console.log(`Đã seed: user:${u.userId} (${u.username}, ${u.role})`);
    }

    console.log('Seed hoàn tất!');
  } catch (err) {
    console.error('Seed thất bại:', err.message);
    process.exitCode = 1;
  } finally {
    if (client.isOpen) await client.quit();
  }
}

seed();
