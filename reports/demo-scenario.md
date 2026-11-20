# Kịch bản demo Redis và Firebase/Firestore

> **Mục tiêu:** trình bày luồng xác thực của ứng dụng và chứng minh phiên sống được xử lý ở Redis, còn dữ liệu bền được đồng bộ sang Firestore.
>
> **Thời lượng:** 8–12 phút  
> **URL:** http://localhost:3000  
> **Tài khoản demo:** `nguyenvana` / `123456` (USER); `admin` / `admin123` (ADMIN nếu đã seed).

## 1. Luồng cần trình bày

```text
Trình duyệt (cookie HttpOnly)
        │ POST /api/login, /api/logout, ...
        ▼
Node.js + Express
   ├── Redis: xác thực phiên sống, TTL, khóa đăng nhập, thu hồi phiên,
   │          audit/security streams và chỉ mục phiên
   └── Firestore: users, activity_events, session_history, thống kê,
                  receipts và checkpoints (đồng bộ nền)
```

Redis quyết định request hiện tại còn đăng nhập hay không. Firestore nhận bản ghi lâu dài từ Redis Streams qua worker nền; việc đồng bộ Firestore không quyết định phiên có hợp lệ hay không.

## 2. Chuẩn bị

### 2.1 Cấu hình

Trong file `.env`, kiểm tra các giá trị (không chia sẻ file hoặc credential trên màn hình):

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6380
FIRESTORE_SYNC_ENABLED=true
FIREBASE_PROJECT_ID=<project-id>
AUTH_LOCK_SECONDS=10
```

`AUTH_LOCK_SECONDS=10` phù hợp để demo khóa tài khoản. Mặc định trong mã là 900 giây nếu không đặt biến này. Không cần mở hoặc in service-account credential.

### 2.2 Khởi động Redis và server

Mở PowerShell tại thư mục project:

```powershell
docker ps
docker exec <ten-container-redis> redis-cli PING
```

Đảm bảo container đang chạy và port host 6380 map tới Redis 6379. Kết quả `PING` mong đợi là `PONG`. Nếu container đang dừng, dùng Docker Desktop hoặc:

```powershell
docker start <ten-container-redis>
```

Trong một PowerShell khác:

```powershell
npm start
```

Log mong đợi: Redis kết nối thành công, Firestore sync bật cho đúng project, server lắng nghe port 3000. Để cửa sổ này mở.

Nếu gặp `EADDRINUSE :::3000`, một server khác đang chạy. Dùng server hiện có và mở URL; không chạy bản thứ hai song song.

### 2.3 Mở các công cụ

1. **Trình duyệt:** http://localhost:3000/login.html
2. **F12 → Network:** bật **Preserve log**, lọc **Fetch/XHR**. Có thể mở **Application → Cookies → localhost** để quan sát cookie; không chụp/chia sẻ giá trị cookie.
3. **Redis Insight:** kết nối host `127.0.0.1`, port `6380` (hoặc cấu hình thực tế của bạn).
4. **Firebase Console → Firestore Database → Data:** chọn project đúng với `FIREBASE_PROJECT_ID`; mở các collection ở mục 5.

Worker đồng bộ nền nên Firestore có thể trễ vài giây; chờ một nhịp rồi refresh.

## 3. Kịch bản demo chính

### Bước 1 — Đăng nhập thành công

**Thao tác:** đăng nhập `nguyenvana` / `123456`.

- **Giao diện:** chuyển đến dashboard.
- **F12 → Network:** `POST /api/login` trả status `200`; response báo thành công.
- **Application → Cookies:** cookie phiên được tạo cho localhost. Không copy giá trị cookie.
- **Redis Insight:** xem các key:

| Key | Kiểu | Kết quả mong đợi |
|---|---|---|
| `session:<sessionId>` | Hash | Có phiên mới, dữ liệu user và thời hạn |
| `user:sessions:1001` | Set | Có session ID của user demo |
| `user:sessions:order:1001` | Sorted Set | Session mới trong chỉ mục theo thời gian |
| `audit:auth:global` | Stream | Có event `LOGIN_SUCCESS` |
| `audit:auth:user:1001` | Stream | Có event của tài khoản |

Nếu có cảnh báo thiết bị mới/baseline, có thể xuất hiện thêm `security:alerts:events` và key `security:*`; chúng không bắt buộc để login thành công.

- **Firestore:** sau khi đợi worker và refresh, kiểm tra:
  - `users/1001`: hồ sơ người dùng.
  - `activity_events`: event đăng nhập thành công.
  - `session_history/<opaque-ref>`: bản ghi phiên mới đang hoạt động.
  - `user_auth_stats/1001`, `system_auth_stats/total`: bộ đếm được cập nhật.
  - `auth_event_receipts`, `auth_sync_checkpoints`: event đã xử lý và vị trí đồng bộ.

**Câu trình bày:** “Redis tạo và kiểm tra phiên trực tiếp. Worker đọc event stream rồi ghi lịch sử và thống kê sang Firestore. Session reference trong Firestore là mã mờ, không phải cookie hay token đăng nhập.”

### Bước 2 — Xác nhận phiên còn hiệu lực

Mở tab mới trong cùng trình duyệt hoặc refresh dashboard.

- F12: request xác thực như `/api/me` trả `200`.
- Redis: `session:<sessionId>` còn tồn tại và ID có trong `user:sessions:1001`.
- Firestore: lịch sử phiên có bản ghi tương ứng.

Giải thích: trình duyệt gửi cookie, backend kiểm tra phiên ở Redis.

### Bước 3 — Đăng xuất

Bấm đăng xuất.

- F12: `POST /api/logout` trả thành công; cookie bị xóa khỏi trình duyệt.
- Redis: `session:<sessionId>` bị xóa; ID bị loại khỏi `user:sessions:1001` và chỉ mục thứ tự; audit stream có `LOGOUT`.
- Firestore: `activity_events` có event `LOGOUT`; document tương ứng trong `session_history` được đánh dấu kết thúc sau khi worker đồng bộ.
- Thử refresh dashboard: không còn đăng nhập và được đưa về trang login.

### Bước 4 — Thu hồi tất cả phiên

Đăng nhập lại. Muốn minh họa nhiều phiên, đăng nhập cùng tài khoản ở trình duyệt thường và cửa sổ ẩn danh. Sau đó gọi chức năng **Đăng xuất tất cả thiết bị** trên dashboard, hoặc gửi `POST /api/logout-all` từ phiên đang đăng nhập.

- F12: `POST /api/logout-all` trả thành công.
- Redis: `SCARD user:sessions:1001` trả `0`; phiên bị thu hồi; audit stream có `LOGOUT_ALL`.
- Firestore: `activity_events` có event `LOGOUT_ALL`; các bản ghi `session_history` được kết thúc sau khi worker chạy.
- Tab/cửa sổ còn lại: refresh sẽ bị đưa về login vì phiên đã bị thu hồi ở Redis.

Endpoint này thu hồi tất cả phiên của tài khoản, bao gồm phiên đang gọi.

## 4. Tùy chọn — minh họa khóa đăng nhập 10 giây

Chỉ thực hiện nếu muốn minh họa chống đoán mật khẩu; việc này tạo thêm event thất bại trong lịch sử. Làm ở cuối demo.

1. Dùng username demo đã seed, ví dụ `nguyenvana`.
2. Nhập sai mật khẩu 5 lần liên tiếp.
3. Các lần đầu dự kiến trả `401`; khi đạt ngưỡng, request tiếp theo dự kiến bị giới hạn với `429` và thời gian chờ khoảng 10 giây.
4. Redis Insight: kiểm tra `auth:lock:nguyenvana` và TTL; xem event `LOGIN_FAILED` / `LOGIN_LOCKED` trong `audit:auth:global`.
5. Sau đồng bộ, Firestore `activity_events` có event tương ứng và thống kê thay đổi.
6. Chờ khóa hết hạn rồi đăng nhập đúng để chứng minh tài khoản dùng lại được.

Không chạy nếu không muốn thêm dữ liệu thử. 10 giây chỉ là cấu hình demo; khi bỏ biến môi trường, mặc định trong mã là 900 giây.

## 5. Đối chiếu dữ liệu

### Redis Insight

Tìm các key (không phải tất cả đều tồn tại nếu chưa có event tương ứng):

```text
session:<sessionId>
user:sessions:1001
user:sessions:order:1001
auth:lock:<username>
audit:auth:global
audit:auth:user:1001
security:alerts:events
```

`session:*` là trạng thái phiên sống. Các stream `audit:*` và `security:*` là event Redis với thời gian lưu theo cấu hình.

### Firestore

| Collection | Ý nghĩa |
|---|---|
| `users` | Hồ sơ người dùng bền |
| `activity_events` | Event đăng nhập, đăng xuất, thu hồi và bảo mật |
| `session_history` | Lịch sử phiên và trạng thái kết thúc |
| `user_auth_stats` | Thống kê theo user |
| `system_auth_stats` | Thống kê toàn hệ thống |
| `auth_event_receipts` | Chống áp dụng cùng event nhiều lần khi retry |
| `auth_sync_checkpoints` | Vị trí worker đã đọc trong từng Redis stream |

Firestore là đích đồng bộ nền; có thể chậm hơn Redis vài giây. Không dùng Firestore để quyết định phiên hiện tại còn sống hay không.

### F12 Developer Tools

- **Network:** xem method, URL và status của `POST /api/login`, `POST /api/logout`, `POST /api/logout-all` và request tải thông tin user.
- **Application → Cookies:** xác nhận cookie được tạo/xóa. Cookie `HttpOnly` không đọc được qua `document.cookie`; đó là bình thường.
- Tránh **Copy as cURL** hoặc chia sẻ HAR vì có thể làm lộ cookie phiên.

## 6. Câu hỏi thường gặp khi thuyết trình

**Redis và Firestore cùng lưu session?**  
Redis giữ phiên đang hoạt động để kiểm tra và thu hồi nhanh. Firestore giữ lịch sử phiên để truy vấn lâu dài; không thay Redis trong xác thực request hiện tại.

**Vì sao Firestore cập nhật chậm?**  
Worker đọc từ Redis Streams rồi ghi transaction vào Firestore. Đợi vài giây và refresh; nếu vẫn chưa thấy, kiểm tra log worker và checkpoint.

**Nếu Firestore tạm lỗi, đăng nhập có hoạt động không?**  
Phiên vẫn do Redis quyết định. Worker ghi lỗi và thử đồng bộ lại từ checkpoint; Firestore có thể chưa cập nhật cho tới khi đồng bộ thành công.

**Có đảm bảo tuyệt đối không mất dữ liệu không?**  
Không. Stream Redis có retention. Redis mất dữ liệu hoặc worker dừng lâu hơn thời gian lưu stream có thể làm mất phần chưa đồng bộ. Môi trường cần độ bền cao phải cấu hình persistence/backup Redis phù hợp.

## 7. Xử lý lỗi nhanh

| Triệu chứng | Kiểm tra / xử lý |
|---|---|
| `ECONNREFUSED 127.0.0.1:6380` | Redis chưa chạy hoặc chưa map port 6380; kiểm tra `docker ps`, port mapping và `PING`. |
| `EADDRINUSE :::3000` | Server khác đang chiếm port; dùng server đang chạy hoặc dừng đúng tiến trình cũ trước khi chạy lại. |
| Login đúng nhưng báo sai | Chạy `npm run seed`; kiểm tra dữ liệu user trong đúng Redis và `REDIS_URL`. |
| Login trả `429` | Có thể tài khoản đang bị khóa; xem TTL `auth:lock:<username>`, đợi hết TTL rồi thử lại. |
| Redis cập nhật nhưng Firestore chưa thấy | Xác nhận `FIRESTORE_SYNC_ENABLED=true`, đúng project ID và quyền ADC/service identity; xem log, checkpoint và stream nguồn. |
| Firebase báo lỗi quyền | Admin SDK cần identity có quyền Firestore trong project; không đưa credential lên Git hoặc ảnh demo. |
| Mở nhầm database/project | So sánh project trên log khởi động với Firebase Console. |

## 8. Checklist kết thúc

- [ ] Đăng nhập đúng tài khoản demo.
- [ ] F12 thấy request login/logout thành công.
- [ ] Redis có phiên sau login và phiên biến mất sau logout.
- [ ] Firestore có profile, event, lịch sử phiên sau khi worker đồng bộ.
- [ ] Logout-all làm phiên trong các cửa sổ khác mất hiệu lực.
- [ ] Nếu thử khóa, TTL hết và có thể đăng nhập lại.
- [ ] Không lộ cookie, file `.env`, credential JSON hoặc bí mật trong ảnh/video.

## 9. Lệnh Redis tham khảo

Chạy trong Redis Insight CLI hoặc `redis-cli` kết nối đúng Redis của ứng dụng:

```redis
PING
SMEMBERS user:sessions:1001
SCARD user:sessions:1001
ZRANGE user:sessions:order:1001 0 -1 WITHSCORES
TTL auth:lock:nguyenvana
XREVRANGE audit:auth:global + - COUNT 10
XREVRANGE audit:auth:user:1001 + - COUNT 10
XREVRANGE security:alerts:events + - COUNT 10
```

Stream sẽ rỗng nếu chưa có event tương ứng. `TTL` trả `-2` nếu key không tồn tại và `-1` nếu key không có TTL.

---

**Lưu ý:** chỉ dùng tài khoản và dữ liệu thử nghiệm. Không chạy `FLUSHDB` hoặc xóa collection để “dọn demo” trên project có dữ liệu cần giữ.

