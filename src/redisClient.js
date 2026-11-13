// ============================================================
// redisClient.js - Kết nối tới Redis (Docker đang chạy sẵn)
// Redis: 127.0.0.1:6380 (KHÔNG tạo/sửa container Docker)
// ============================================================
const { createClient } = require('redis');

// REDIS_URL can point tests or other environments at an isolated Redis server.
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';

const client = createClient({
  url: REDIS_URL,
  socket: {
    // Thử lại tối đa 3 lần rồi dừng, tránh log lỗi vô tận
    reconnectStrategy: (retries) => (retries >= 3 ? false : 1000),
  },
});

// Log lỗi rõ ràng khi mất kết nối / không kết nối được
client.on('error', (err) => {
  console.error(`[Redis ERROR] Không thể kết nối tới ${REDIS_URL}: ${err.message}`);
});

// Hàm kết nối - gọi 1 lần khi khởi động server hoặc seed
async function connectRedis() {
  try {
    await client.connect();
    console.log('Redis connected successfully');
  } catch (err) {
    console.error('==============================================');
    console.error(`[Redis ERROR] Kết nối thất bại tới ${REDIS_URL}`);
    console.error(`Chi tiết: ${err.message}`);
    console.error('Hãy kiểm tra: ');
    console.error('  1. Container Redis đã chạy chưa?  ->  docker ps');
    console.error('  2. Port 6380 có được map ra máy host không?');
    console.error('  3. Firewall/antivirus có chặn 127.0.0.1:6380 không?');
    console.error('(Chương trình KHÔNG thay đổi Docker, vui lòng tự kiểm tra)');
    console.error('==============================================');
    throw err;
  }
}

module.exports = { client, connectRedis };
