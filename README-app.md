# Redis Session Management Demo

Project minh họa đề tài:

> **“Tìm hiểu Redis Insight để quản trị và khai thác Redis trong quản lý phiên đăng nhập người dùng và xây dựng ứng dụng minh họa”.**

Ứng dụng web đăng nhập đơn giản, toàn bộ dữ liệu (user, session, bộ đếm) chỉ lưu trong **Redis**. Session được tự viết bằng các lệnh Redis thuần (`HSET`, `EXPIRE`, `SADD`...) để dễ quan sát trong Redis Insight. Không dùng JWT, không dùng thư viện session store tự động.

---

## 1. Công nghệ sử dụng

| Công nghệ | Vai trò |
|---|---|
| **Node.js** | Môi trường chạy backend (CommonJS, dùng `require()`) |
| **Express** | Web framework: tạo API và phục vụ file tĩnh |
| **Redis** | Cơ sở dữ liệu duy nhất: lưu user, session, bộ đếm đăng nhập |
| **Redis Insight** | Công cụ GUI để quan sát key, TTL, Profiler, CLI, Workbench |
| **Docker Desktop** | Chạy sẵn Redis Server trong container |
| **HTML / CSS / JavaScript** | Giao diện web thuần (không React/Vue) |
| **bcrypt** | Băm mật khẩu, không lưu plain text |
| **cookie-parser** | Đọc cookie `sessionId` từ request |

---

## 2. Môi trường Redis hiện tại

**Redis Server** (chạy sẵn bằng Docker):

- Host: `127.0.0.1`
- Port: `6380`
- Container: `redis-nosql-session`

**Redis Insight:**

- Kết nối vào `127.0.0.1:6380`.
- Dùng để quan sát key, TTL, Profiler, Database Analysis, CLI và Workbench.

> [!IMPORTANT]
> **Redis Insight không phải nơi lưu dữ liệu.** Redis Server mới là nơi lưu dữ liệu. Redis Insight chỉ là công cụ quản trị và quan sát.

---

## 3. Cấu trúc thư mục

```
redis-session-app/
├── package.json
├── server.js
├── README.md
├── .gitignore
├── src/
│   ├── redisClient.js
│   ├── sessionService.js
│   ├── authMiddleware.js
│   └── lua/
│       ├── createSessionLimited.lua
│       └── recordLoginFailure.lua
├── scripts/
│   └── seedUsers.js
├── test/
│   └── sessionLimit.test.js
└── public/
    ├── login.html
    ├── dashboard.html
    ├── style.css
    └── script.js
```

| File | Công dụng |
|---|---|
| `package.json` | Khai báo dependencies và script `start`, `seed`, `test` |
| `server.js` | Express server (cổng 3000), định nghĩa các API, serve thư mục `public` |
| `src/redisClient.js` | Kết nối Redis `redis://127.0.0.1:6380`, log kết quả kết nối |
| `src/sessionService.js` | Logic session Redis: tạo, lấy, gia hạn, xóa, liệt kê session, đọc bộ đếm |
| `src/authMiddleware.js` | Kiểm tra cookie `sessionId` với Redis, trả 401 nếu không hợp lệ |
| `scripts/seedUsers.js` | Tạo 2 user mẫu trong Redis (mật khẩu băm bằng bcrypt) |
| `public/login.html` | Trang đăng nhập |
| `public/dashboard.html` | Trang hiển thị thông tin phiên, số lần đăng nhập, danh sách session, nút Logout |
| `public/style.css` | Giao diện chung |
| `public/script.js` | JavaScript thuần cho cả 2 trang (gọi API bằng `fetch`) |

---

## 4. Cài dependencies

```bash
npm install
```

Các package chính:

- `express`
- `redis` (node-redis v4)
- `bcrypt`
- `cookie-parser`

---

## 5. Khởi tạo dữ liệu mẫu

```bash
npm run seed
```

Sau khi seed, Redis có các key:

```
user:1001
user:1002
username:nguyenvana
username:tranthib
```

| | User 1 | User 2 |
|---|---|---|
| userId | `1001` | `1002` |
| username | `nguyenvana` | `tranthib` |
| password | `123456` | `123456` |
| role | `USER` | `ADMIN` |

> **Ghi chú:** mật khẩu thật được lưu dưới dạng `passwordHash` (bcrypt), **không lưu plain text**.
> Có thể chạy seed nhiều lần, dữ liệu chỉ bị ghi đè lại, không gây lỗi.

---

## 6. Chạy project

```bash
npm start
```

Khi thành công, console hiển thị:

```
Redis connected successfully
Server đang chạy tại http://localhost:3000
```

Mở trình duyệt: **http://localhost:3000** (tự chuyển tới `/login.html`).

---

## 7. Luồng đăng nhập

1. User nhập username/password.
2. Backend tìm user trong Redis (`GET username:<username>` → `HGETALL user:<userId>`).
3. Backend kiểm tra password bằng `bcrypt.compare()`.
4. Nếu đúng, backend sinh `sessionId` bằng `crypto.randomUUID()`.
5. Backend tạo Hash `session:<sessionId>` (`HSET`).
6. Backend đặt hạn: `EXPIRE session:<sessionId> 1800`.
7. Backend thêm session vào Set: `SADD user:sessions:<userId> <sessionId>`.
8. Backend tăng bộ đếm: `INCR login:count:<userId>`.
9. Session ID được gửi về trình duyệt qua cookie `sessionId` (`httpOnly`, `sameSite=lax`).

```
Frontend (HTML/CSS/JS)
   ↓  fetch /api/...
Express Backend (Node.js)
   ↓  lệnh Redis
Redis Server (127.0.0.1:6380)
   ↓
Redis Insight quan sát (Browser / Profiler / CLI)
```

Với mỗi request cần đăng nhập, `authMiddleware` kiểm tra `EXISTS` + `HGETALL session:<id>` và gia hạn TTL về 1800 giây (**sliding session**).

---

## 8. Thiết kế key Redis

| Key | Kiểu dữ liệu | Mục đích |
|---|---|---|
| `user:<userId>` | Hash | Lưu thông tin user (`username`, `passwordHash`, `role`, `email`) |
| `username:<username>` | String | Mapping username sang userId |
| `session:<sessionId>` | Hash | Lưu phiên đăng nhập (`userId`, `username`, `role`, `device`, `ip`, `loginTime`) |
| `user:sessions:<userId>` | Set | Danh sách sessionId của user |
| `user:sessions:order:<userId>` | Sorted Set | Thứ tự tạo session theo Unix timestamp mili giây |
| `login:count:<userId>` | String | Đếm số lần đăng nhập thành công |
| `auth:fail:events:<username>` | Sorted Set | Các lần đăng nhập sai trong cửa sổ trượt 15 phút; TTL 900 giây |
| `auth:lock:<username>` | String | Trạng thái khóa tạm thời; TTL 900 giây |

**Session có TTL 1800 giây (30 phút).**

---

### Giới hạn session

Mỗi tài khoản giữ tối đa 3 session còn hiệu lực. Khi đăng nhập mới vượt giới hạn, session cũ nhất theo thời điểm tạo bị thu hồi. `user:sessions:<userId>` tiếp tục là Set các session ID; `user:sessions:order:<userId>` là Sorted Set sắp theo thời điểm tạo (Unix milliseconds). Lua Script cập nhật Hash, hai chỉ mục và bộ đếm trong cùng thao tác nguyên tử. Các session cũ được đưa vào Sorted Set từ `loginTime` khi đăng nhập kế tiếp; session hết hạn được dọn khỏi cả hai chỉ mục khi tạo hoặc liệt kê session.

### Kiểm thử tích hợp BR-01/BR-02

Các bài kiểm thử cần một Redis riêng biệt. Không trỏ `REDIS_TEST_URL` tới Redis đang chứa dữ liệu đồ án. Ví dụ PowerShell khi Redis test đã chạy ở cổng riêng:

```powershell
$env:REDIS_TEST_URL = 'redis://127.0.0.1:16380'
npm test
Remove-Item Env:REDIS_TEST_URL
```

Nếu `REDIS_TEST_URL` chưa được đặt, bài kiểm thử tích hợp sẽ SKIP để tránh ghi nhầm vào Redis mặc định `127.0.0.1:6380`.

Lua limits legacy index repair to 1000 members per index to bound Redis script execution time. If an index exceeds that limit, login fails before any session data is changed and the index must be repaired separately.

### Chống đăng nhập sai (BR-03)

Cho phép tối đa 4 lần sai trong 15 phút; lần thứ 5 tạo khóa 15 phút theo username đã trim. Username vẫn phân biệt chữ hoa/thường như tra cứu hiện tại. Các lần sai được lưu trong Sorted Set với thời điểm do Redis cấp; khi bắt đầu khóa, event cũ bị xóa để hết khóa không lập tức khóa lại. Đăng nhập thành công xóa streak sai trong cùng Lua script tạo session. Script này kiểm tra trạng thái khóa cuối cùng trước khi thay đổi session, nên race với login sai không thể tạo session sau khi khóa đã có hiệu lực.

Trạng thái đang khóa trả HTTP 429, `Retry-After` và `retryAfterSeconds`. Lỗi xác thực thông thường vẫn trả cùng thông báo cho username tồn tại/không tồn tại. Khóa không thu hồi hoặc gia hạn TTL các session đã có.

Thời gian mặc định là 900 giây. Có thể đặt `AUTH_FAILURE_WINDOW_SECONDS` và `AUTH_LOCK_SECONDS` để cấu hình môi trường riêng; bộ test chỉ rút ngắn hai giá trị này khi `REDIS_TEST_URL` được chỉ định.

### Kiểm thử tích hợp BR-03

`npm test` bổ sung TC-01 đến TC-12. Các test tích hợp chỉ chạy khi đặt `REDIS_TEST_URL` trỏ tới Redis test riêng; không trỏ biến này tới DB đồ án.

## 9. API

| Method | Đường dẫn | Cần đăng nhập | Mục đích |
|---|---|:---:|---|
| POST | `/api/login` | Không | Đăng nhập, tạo session |
| GET | `/api/me` | Có | Thông tin phiên hiện tại |
| GET | `/api/sessions` | Có | Danh sách session còn hiệu lực của user |
| GET | `/api/login-count` | Có | Số lần đăng nhập |
| POST | `/api/logout` | Không bắt buộc | Xóa session, xóa cookie |

### POST `/api/login`

Request:

```json
{ "username": "nguyenvana", "password": "123456" }
```

Response (200):

```json
{
  "success": true,
  "message": "Đăng nhập thành công",
  "user": { "userId": "1001", "username": "nguyenvana", "role": "USER" }
}
```

Sai tài khoản hoặc mật khẩu → HTTP `401`, thiếu dữ liệu → HTTP `400`:

```json
{ "success": false, "message": "Sai tài khoản hoặc mật khẩu" }
```

Đang bị khóa → HTTP `429`, kèm header `Retry-After` và JSON `retryAfterSeconds`.

### GET `/api/me`

```json
{
  "userId": "1001",
  "username": "nguyenvana",
  "role": "USER",
  "device": "Mozilla/5.0 ...",
  "ip": "127.0.0.1",
  "loginTime": "2026-10-06T14:50:00.000Z",
  "sessionId": "b1c4e9a2-...-uuid"
}
```

Chưa đăng nhập hoặc session hết hạn → HTTP `401`.

### GET `/api/sessions`

Trả mảng các session còn hợp lệ (tham chiếu session hết hạn được dọn khỏi Set và Sorted Set). Mỗi phần tử có thêm `ttl` (giây còn lại) và `current` (có phải phiên hiện tại):

```json
[
  {
    "sessionId": "b1c4e9a2-...-uuid",
    "userId": "1001",
    "username": "nguyenvana",
    "role": "USER",
    "device": "Mozilla/5.0 ...",
    "ip": "127.0.0.1",
    "loginTime": "2026-10-06T14:50:00.000Z",
    "ttl": 1795,
    "current": true
  }
]
```

### GET `/api/login-count`

```json
{ "userId": "1001", "count": 6 }
```

### POST `/api/logout`

Không cần body. Response:

```json
{ "success": true, "message": "Đăng xuất thành công" }
```

---

## 10. Demo với Redis Insight

### Login

1. Mở **Browser** và **Profiler** trong Redis Insight (bấm *Start Profiler*).
2. Đăng nhập trên web (`nguyenvana / 123456`).
3. Trong Browser, quan sát key `session:<UUID>` (kiểu Hash) vừa được tạo.
4. Kiểm tra **TTL** của key này (đếm ngược từ 1800 giây).
5. Mở `user:sessions:1001` → thấy UUID vừa tạo.
6. Mở `login:count:1001` → giá trị tăng lên 1 sau mỗi lần login.
7. Profiler sẽ thấy các command tương tự:

```
GET username:nguyenvana
HGETALL user:1001
HSET session:<uuid> userId 1001 username nguyenvana role USER device ... ip ... loginTime ...
EXPIRE session:<uuid> 1800
SADD user:sessions:1001 <uuid>
INCR login:count:1001
```

### Kiểm tra session

Dùng CLI hoặc Workbench:

```
HGETALL session:<sessionId>
TTL session:<sessionId>
EXISTS session:<sessionId>
```

### Danh sách session của user

```
SMEMBERS user:sessions:1001
```

### Logout

Khi bấm Logout, Profiler thấy:

```
DEL session:<sessionId>
SREM user:sessions:1001 <sessionId>
```

Key `session:<sessionId>` biến mất khỏi Browser.

> **Mẹo demo:** đăng nhập từ 2 trình duyệt khác nhau để thấy `user:sessions:1001` có 2 UUID, và dashboard liệt kê 2 session.

---

## 11. Một số command Redis dùng trong đồ án

| Command | Ý nghĩa | Dùng trong code? |
|---|---|:---:|
| `SET` | Ghi giá trị String (`username:<name>` → userId) | Có (seed) |
| `GET` | Đọc String (userId, bộ đếm đăng nhập) | Có |
| `HSET` | Ghi nhiều field vào Hash (user, session) | Có |
| `HGETALL` | Đọc toàn bộ field của Hash | Có |
| `HGET` | Đọc 1 field của Hash | Không (chỉ dùng thử trong CLI) |
| `EXISTS` | Kiểm tra key tồn tại | Có |
| `EXPIRE` | Đặt thời gian sống (TTL) cho key | Có |
| `TTL` | Xem số giây còn lại của key | Có (cột "TTL còn lại" trên dashboard) |
| `SADD` | Thêm phần tử vào Set | Có |
| `SMEMBERS` | Liệt kê phần tử của Set | Có |
| `SREM` | Xóa phần tử khỏi Set | Có |
| `ZADD` / `ZRANGE` / `ZREM` | Quản lý thứ tự tạo và dọn session | Có |
| `EVAL` | Chạy Lua nguyên tử để giới hạn/tạo/xóa session | Có |
| `INCR` | Tăng số nguyên lên 1 | Có |
| `DEL` | Xóa key | Có |
| `SCAN` | Duyệt key theo từng phần, an toàn hơn `KEYS` | Không (chỉ dùng thử trong CLI/Insight) |
| `MULTI` / `EXEC` | Gom nhiều lệnh thành transaction | Không (project cố ý gửi từng lệnh riêng để Profiler dễ quan sát) |

---

## 12. Backup Redis

Các command dùng trong báo cáo (chạy thủ công ở PowerShell/CMD, **README không tự chạy**):

```bash
docker exec redis-nosql-session redis-cli BGSAVE
docker exec redis-nosql-session redis-cli LASTSAVE
docker exec redis-nosql-session redis-cli CONFIG GET dir
docker exec redis-nosql-session redis-cli CONFIG GET dbfilename
```

| Command | Giải thích |
|---|---|
| `BGSAVE` | Lưu snapshot RDB ở chế độ nền |
| `LASTSAVE` | Thời điểm (Unix timestamp) lần lưu gần nhất |
| `CONFIG GET dir` | Thư mục lưu file backup trong container |
| `CONFIG GET dbfilename` | Tên file backup |

Nếu Redis trả `dir = /data` và `dbfilename = dump.rdb`, thì với bind mount hiện tại file có thể nằm tại:

```
D:\RedisNoSQL\data\dump.rdb
```

---

## 13. Lưu ý

- Redis Server phải chạy **trước** khi `npm start`.
- Port Redis là **6380** trên Windows.
- Không dùng MySQL/PostgreSQL/MongoDB trong project này.
- Redis Insight chỉ dùng để quản trị và quan sát.
- Session ID sinh tự động bằng `crypto.randomUUID()`, không hard-code `S001`.
- Session có TTL 1800 giây.
- Password không lưu plain text (bcrypt).
- Không commit `node_modules`.
- Không commit dữ liệu nhạy cảm nếu sau này thêm file `.env`.

Nếu `npm start` hoặc `npm run seed` báo lỗi kết nối Redis, hãy kiểm tra (không cần sửa project):

```bash
docker ps
```

Container `redis-nosql-session` phải đang chạy và port `6380` được map ra máy host.

---

## 14. Tài khoản demo

| Vai trò | Tài khoản |
|---|---|
| User | `nguyenvana` / `123456` |
| Admin | `tranthib` / `123456` |

> Chỉ dùng cho mục đích demo học tập.

---

## 15. Mục tiêu đồ án

Project được xây dựng để minh họa cách Redis quản lý phiên đăng nhập, cách backend tương tác với Redis, và cách Redis Insight được sử dụng để quan sát, kiểm tra và phân tích dữ liệu Redis.

## Session revocation and logout all

New session hashes include a separate `managementId` UUID for selecting a session to revoke. It is not an authentication cookie. Existing sessions receive this field lazily when read; the operation preserves their TTL. API responses expose `managementId` and omit the authentication `sessionId`.

| Method | Endpoint | Purpose |
|---|---|---|
| `DELETE` | `/api/sessions/:managementId` | Revoke another session owned by the authenticated account. The current session returns 400 and must use `/api/logout`. |
| `POST` | `/api/logout-all` | Atomically revoke every session for the authenticated account, including the current one, and clear its cookie. |

Both operations use atomic Lua scripts on that account's indexes. A login committed after logout-all completes remains active. Mutating endpoints require a same-origin `Origin` header. User hashes, login counters, login locks, and failure events are preserved.

The dashboard offers revoke actions for other sessions and a confirmation before logging out all devices. Integration coverage is in `test/sessionRevocation.test.js`; run `npm test` with `REDIS_TEST_URL` pointed at an isolated Redis instance such as `redis://127.0.0.1:16380`, never the project Redis on port 6380.

> **API example correction:** Earlier `/api/me` and `/api/sessions` examples in this README predate management IDs. Current responses omit `sessionId` and use `managementId`, which cannot authenticate requests. The login cookie remains HttpOnly and is handled only by the browser/backend.

## BR-04 Admin session management

An authenticated ADMIN can open `/admin.html` from the personal dashboard. The page lists accounts, active-session counts, system totals, and the target account's active sessions. USER accounts cannot load that page through the server route, and every `/api/admin/*` endpoint checks authorization on the backend.

Admin endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/admin/overview` | Current account and active-session totals, including role breakdown |
| `GET` | `/api/admin/users?limit=25&offset=0&q=` | Paginated account search by userId or username; maximum page size 100 |
| `GET` | `/api/admin/users/:userId/sessions` | Active sessions for a selected account |
| `DELETE` | `/api/admin/users/:userId/sessions/:managementId` | Revoke one target session; revoking the acting Admin's current session clears its cookie |
| `POST` | `/api/admin/users/:userId/logout-all` | Revoke all target sessions; self logout-all clears the acting Admin cookie |

`requireAdmin` first uses the existing session cookie and then reads the current role from `user:<userId>` in Redis. It does not trust a role supplied by the browser or the potentially stale session role. Mutating Admin endpoints check same-origin `Origin` before session middleware can refresh a TTL. The session revoke endpoints reuse the existing Lua scripts and do not create additional Redis keys.

Account discovery uses cursor-based Redis `SCAN` with `MATCH user:*`, then accepts only exact `user:<id>` Hash keys. Session Set/ZSET keys and other `user:*` keys are excluded. The API returns only userId, username, email, role, and active-session count; no passwordHash or authentication sessionId is returned. Overview statistics are calculated from current Redis users and their indexed active sessions, not login history.

The account table has bounded pages and search. Since the current data model has no user index, each account listing/overview scans the matching keyspace and verifies candidate Hash types. That keeps data compatible with the existing seed and records without creating synchronization work, but a very large deployment should add a maintained user index or move these reports to a background job.

BR-04 integration cases are in `test/adminSessions.test.js` (TC-01 through TC-20). Run them with the full suite using `REDIS_TEST_URL` pointed to a disposable Redis, for example `redis://127.0.0.1:16380`; never use the project database on port 6380 for tests.

## BR-05: audit history with Redis Streams

BR-05 stores authentication and session-management activity in Redis Streams. Stream entry IDs are generated by Redis and read newest-first with `XREVRANGE`.

### Stream keys and event fields

- `audit:auth:global`: one entry for each logical event, available only through Admin APIs.
- `audit:auth:user:<userId>`: one corresponding entry for each account related to the event. When actor and target are the same account, only one copy is written to that account stream. An Admin action against another account appears once in the target stream and once in the acting Admin's personal stream.
- Unknown-username login failures go only to the global stream; they do not create a user hash or a fake user stream.

Supported event types: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGIN_LOCKED`, `LOGOUT`, `SESSION_REVOKED`, `LOGOUT_ALL`, `SESSION_AUTO_REVOKED`, `ADMIN_SESSION_REVOKED`, and `ADMIN_LOGOUT_ALL`.

Entries contain a logical `eventId`, event type, actor/target IDs and roles when known, username, Redis-time `occurredAtMs`, result, and bounded IP/device/reason fields as applicable. The event ID links copies in different streams. Passwords, password hashes, cookie values, auth `sessionId`, and `managementId` are never included.

### History APIs

| Method | Endpoint | Access | Details |
|---|---|---|---|
| `GET` | `/api/history?limit=20&cursor=...` | Any authenticated user | Only reads the user ID from the verified session. A client `userId` filter is rejected. Supports event type and from/to time filters. |
| `GET` | `/api/admin/history?limit=20&cursor=...&userId=...` | Current ADMIN role | Reads the global stream; userId matches either event actor or target. Supports event type and from/to filters. |

Page size defaults to 20 and is capped at 100. Cursor values are Redis Stream IDs. Filters are validated, the retention window is applied server-side, and each request scans at most 500 stream entries. If a sparse filter needs more scanning, `nextCursor` continues from the last scanned position. The frontend renders Redis values with `textContent`.

### Retention and cleanup

`AUDIT_RETENTION_SECONDS` defaults to `2592000` seconds (30 × 24 hours). Every append performs exact `XTRIM MINID = <cutoff>-0` on the touched stream and refreshes that stream key's TTL. History reads trim the selected stream before returning entries. Backend startup performs a cleanup pass; while running, a non-overlapping timer scans `audit:auth:user:*` in bounded batches and trims those streams. The cleanup timer is stopped during graceful shutdown.

An idle stream key expires 30 days after its latest append; because its entries are older than or equal to that latest entry, the key cannot retain an entry younger than the retention limit when it expires. While a stream is active, each append trims old entries. If the service is stopped, periodic trimming pauses; startup cleanup and the key TTL handle the next run and inactive streams.

For tests only, set `AUDIT_RETENTION_SECONDS` to a short positive value. BR-05 integration coverage uses four seconds; the demo default remains 30 days.

### Atomicity and write failures

Session create/eviction, login failure/lock, user/admin revoke, logout, and logout-all write their audit entries inside the same Lua invocation as the business mutation. The scripts validate stream key types before mutating business state. This keeps successful events ordered with the operation and prevents lock-race or failed-revocation events from being invented.

Redis Lua does not roll back prior writes after a later command error. Audit `XADD`/trim/TTL calls therefore use protected calls after the core operation; a business operation can complete while an audit copy is missing if Redis rejects that audit write. In that case the server logs an audit warning and mutation/login responses include `auditRecorded: false` where applicable. A dual-stream event can be present in the global stream but absent from one account stream if Redis fails between the two writes. This is reported as incomplete audit, not as a rolled-back business operation. Wrong-type audit keys are caught before mutation and produce an error without a fake success.

### Demo and Redis Insight

1. Start the project Redis container and run `npm start`.
2. Sign in as a USER, then inspect `/history.html` after login, a failed login, logout, or session revocation.
3. Sign in as ADMIN and open **Lịch sử hệ thống** from `/admin.html` to filter by user, event type, and time.
4. In Redis Insight, browse `audit:auth:global` and `audit:auth:user:<userId>` as Stream keys; compare matching `eventId` values.
5. Test expiry only with the disposable Redis test instance and a short `AUDIT_RETENTION_SECONDS`; never point the test variable at port 6380.

BR-05 tests are in `test/auditHistory.test.js` (TC-01 through TC-24). The full integration suite is `npm test` with `REDIS_TEST_URL` pointing to isolated Redis.

## Frontend management console

The web interface uses HTML, CSS, and Vanilla JavaScript with a shared responsive sidebar and a dark purple design system. The login page is `/login.html`; after login, USER and ADMIN accounts open `/dashboard.html`. The Admin-only page is `/admin.html`; personal activity is at `/history.html`, and Admin system history is at `/admin-history.html`.

Dashboard values and tables are loaded from the existing `/api/me`, `/api/sessions`, `/api/login-count`, and `/api/history` APIs. Admin overview, account search, session inspection, revocation, and logout-all use the existing `/api/admin/*` endpoints. History uses the existing cursor API. The frontend does not store authentication values or use mock activity. Admin page routes and APIs remain protected by backend authorization.

`public/app.js` builds the shared sidebar, responsive mobile drawer, toast messages, and confirmation dialog. UI contract checks are in `test/frontendContract.test.js`; real-browser interaction checks use Playwright under `e2e/`.

## Security Center (SC-01–SC-06)

The authenticated page `/security.html` is available to USER and ADMIN accounts. USER sees only their own alerts. ADMIN sees system-wide alerts and can review USER and ADMIN accounts. Alert severity is rule-based and does not prove an attack occurred.

### Detection and Redis records

- The first successful login after a baseline is absent records the known environment without creating an alert. Failed login attempts never establish a baseline.
- Browser family, operating system, and broad device category form a stable User-Agent signature. The signature is SHA-256 hashed before storing in `security:known:devices:<userId>`. IP addresses are normalized and stored in `security:known:ips:<userId>`. Both are Sets capped at `SECURITY_MAX_KNOWN_MARKERS` (default 200), and baseline/known-marker keys expire after `SECURITY_ALERT_RETENTION_SECONDS` (default 30 days) of inactivity.
- A new device is MEDIUM; a new IP alone is LOW; both in one successful login become one MEDIUM alert. A valid account lock transition on the fifth failure creates a HIGH `LOGIN_LOCKOUT` alert. Repeated attempts during that lock do not create another lockout alert. Unknown usernames never get a fake account or Security Center alert.
- IP and device markers are checked and updated atomically in Lua. Concurrent logins for the same new environment create at most one alert. `SECURITY_ALERT_DEDUPE_SECONDS` defaults to 24 hours. New marker Sets are bounded; reaching the cap evicts an arbitrary old marker, so a later login from that evicted environment may be reported as new again.
- User-Agent is client-controlled and cannot uniquely identify a physical device. IP addresses can change or be shared. Localhost IPv4/IPv6 loopback values normalize to `127.0.0.1`. The app does not trust `X-Forwarded-For` or infer geography.

Redis keys:

| Key pattern | Type | Purpose |
|---|---|---|
| `security:baseline:<userId>` | String with TTL | Indicates an environment baseline exists |
| `security:known:devices:<userId>` | Set with TTL | Hashes of known normalized device signatures |
| `security:known:ips:<userId>` | Set with TTL | Known normalized IP values |
| `security:dedupe:<userId>:<digest>` | String with TTL | Suppresses repeated environment alerts |
| `security:alert:<alertId>` | Hash with 30-day expiry | Alert details and resolution state |
| `security:user:alerts:<userId>` and `security:alerts:global` | Sorted Sets | User and system alert indexes by creation time |
| `...:open`, `...:high`, `...:resolved` | Sorted Sets | Bounded KPI/filter indexes |
| `security:alerts:events` | Stream with retention | System-wide alert processing history |
| `security:alert:events:<alertId>` | Stream with retention | Per-alert event timeline |

Alert hashes do not store passwords, password hashes, auth `sessionId`, or cookie contents. A related `managementId` is stored internally for a possible revoke action; it is not an authentication token and is not returned by the API. `SECURITY_ALERT_CLEANUP_INTERVAL_MS` defaults to 15 minutes. Startup and periodic cleanup remove expired index references and trim streams; alert Hashes and event streams also have their own TTLs. Security Center data is separate from BR-05 `audit:auth:*` streams.

### Alert handling and APIs

`OPEN` alerts can be marked read independently of resolution. Resolution actions are `RESOLVED_SAFE` and `RESOLVED_REVOKED`; the actor and timestamp are stored, and event history is appended. Revoke actions first claim an alert atomically to prevent conflicting safe/revoke decisions, then reuse existing session deletion/revocation services. An ended or expired session is never reported as successfully revoked. Revoking the USER's current related session uses the existing logout deletion path and clears the cookie; an ADMIN revoking their own current session also clears the cookie.

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/security/overview` | Authenticated USER/ADMIN | Personal total/open/high/resolved counts |
| `GET` | `/api/security/alerts` | Authenticated USER/ADMIN | Personal filtered cursor-paginated alerts |
| `GET` | `/api/security/alerts/:alertId` | Alert owner | Alert detail and per-alert event history |
| `PATCH` | `/api/security/alerts/:alertId/read` | Alert owner | Mark read without resolving |
| `PATCH` | `/api/security/alerts/:alertId/resolve` | Alert owner | Confirm safe with `{ "action": "safe" }` |
| `POST` | `/api/security/alerts/:alertId/revoke-session` | Alert owner | Revoke the related active session |
| `GET` | `/api/admin/security/overview` | ADMIN | System-wide alert counts |
| `GET` | `/api/admin/security/alerts` | ADMIN | System-wide filtered cursor-paginated alerts; supports `q` |
| `GET` | `/api/admin/security/alerts/:alertId` | ADMIN | Alert detail and event history |
| `PATCH` | `/api/admin/security/alerts/:alertId/read` | ADMIN | Mark an alert reviewed |
| `PATCH` | `/api/admin/security/alerts/:alertId/resolve` | ADMIN | Confirm safe |
| `POST` | `/api/admin/security/alerts/:alertId/revoke-session` | ADMIN | Revoke the related active session |
| `GET` | `/api/admin/security/alerts/:alertId/events` | ADMIN | Read a bounded per-alert event timeline |

Mutating endpoints retain the existing same-origin Origin check and backend role checks. Lists default to 20 and cap at 100 entries; scanning is bounded to 500 candidates per request. Filters include severity, status, type, date range, and Admin account search. USER identity always comes from the authenticated session, never a client-supplied user ID.

Security monitoring is best-effort after the successful session commit. If Security Center storage fails, the login/session remains successful and the server logs the monitoring error; it does not claim an alert was saved when the alert write failed. As with Redis Lua generally, runtime failures after writes are not rolled back. Alert state transitions and event streams can therefore be partially recorded during Redis faults; the API reports incomplete history where applicable.

### Demo and tests

1. Start the app and sign in at `/login.html`; the first successful environment establishes the baseline silently.
2. Sign in with another browser family or a controlled different source IP to trigger a new-environment alert. A browser User-Agent can be changed by the client, so this is a demonstration signal rather than physical-device proof.
3. Submit a wrong password five times for an existing account to trigger the HIGH lockout alert.
4. Open **Trung tâm bảo mật** from the sidebar as USER, then sign in as ADMIN and inspect system-wide alerts, filters, event timelines, and handling actions.
5. In Redis Insight, inspect `security:alert:*`, `security:user:alerts:*`, `security:alerts:global`, `security:known:*`, and the two security event-stream patterns.

The automated Security Center cases are in `test/securityCenter.test.js` (SC-TC-01 through SC-TC-28). Run the Node.js suite with `REDIS_TEST_URL` set to an isolated Redis instance, for example `redis://127.0.0.1:16380`; never point tests at the project Redis on port 6380.

#### Playwright browser E2E

Install the Chromium build once with `npx playwright install chromium`. Run `npm run test:e2e` to start a disposable Redis 7.2 container bound only to `127.0.0.1:16380`, start the app on port 3100 with an explicit test Redis URL, run the Chromium E2E suite serially, write the HTML report to `playwright-report/`, then remove only the labeled container created by that runner. The test seeder accepts only `redis://127.0.0.1:16380`; it does not call `scripts/seedUsers.js` or the project Redis on port 6380. `npm run test:e2e:headed` runs the same suite with a visible Chromium window. `npm run test:e2e:all` runs Playwright and then the Node.js regression suite on the same disposable Redis before cleanup. `npm run test:e2e:report` opens the most recent HTML report.

The E2E suite seeds random USER/ADMIN accounts directly into the disposable test Redis and uses the real app backend and browser UI. It records screenshots, traces, and video on failure under `test-results/`; these generated artifacts are ignored by Git. E2E-08 (detection from two real source IPs) is skipped because this local setup cannot provide two distinct source IPs without a proxy/network change. New-environment cases use a separate Chromium context with a controlled Safari/iPhone User-Agent; this validates the app's User-Agent detection path, not a separate browser engine or physical device. Browser tests use one worker to keep fixture data independent.

## Export Reports (EX-01–EX-06)

The authenticated **Báo cáo & Xuất dữ liệu** page (`/reports.html`) exports three UTF-8 CSV reports: activity history, current Security Center alerts, and daily activity statistics. USER exports always use the authenticated `req.session.userId`. ADMIN can export all accounts or filter by exact `userId`; backend role middleware protects every Admin export route.

### Redis sources and API

| Report | USER source | ADMIN source | Endpoint |
|---|---|---|---|
| Activity history | `audit:auth:user:<userId>` Stream | `audit:auth:global` Stream | `GET /api/reports/history/export`; `GET /api/admin/reports/history/export` |
| Security alerts | `security:user:alerts:<userId>` Sorted Set and current `security:alert:<alertId>` Hashes | `security:alerts:global` Sorted Set and current alert Hashes | `GET /api/reports/security/export`; `GET /api/admin/reports/security/export` |
| Daily summary | The user's audit Stream and alert index | Global audit Stream and global alert index | `GET /api/reports/summary/export`; `GET /api/admin/reports/summary/export` |

All exports accept `from=YYYY-MM-DD` and `to=YYYY-MM-DD`. The default is the latest seven Vietnam calendar dates. The inclusive range may not exceed 30 days or include future dates. History additionally accepts `eventType`; alert export accepts `severity`, `status`, and `alertType`. Admin routes accept `userId`; a missing value means all accounts. Personal routes reject a supplied `userId`.

The event list comes from the existing `auditService.EVENT_TYPES`. Audit event fields are read as stored: `eventId`, `eventType`, actor/target IDs and usernames, `occurredAtMs`, `result`, `device`, `ip`, `revokedCount`, and `reason`. Admin history reads only the global stream; personal history reads only that account's stream, so the actor and target copies are not combined or double-counted. Unknown event types are omitted. No credentials, cookie, auth session ID, or management ID are exported.

Alert exports use the existing global or per-user creation-time index, then read each current alert Hash. The CSV reflects the current `status`, `readAt`, `resolvedAt`, `resolvedBy`, and `resolution`; exporting does not mark alerts read or otherwise mutate them. Missing/expired Hashes are omitted rather than recreated. Existing alert types are `NEW_LOGIN_ENVIRONMENT` and `LOGIN_LOCKOUT`; severities are `LOW`, `MEDIUM`, and `HIGH`.

Summary CSV columns are day, successful logins, failed logins, lockouts, logout actions, revoked sessions, total alerts, HIGH alerts, LOW alerts, and MEDIUM alerts. A `LOGIN_SUCCESS`, `LOGIN_FAILED`, or `LOGIN_LOCKED` event contributes one to its corresponding metric. Logout actions count `LOGOUT`, `LOGOUT_ALL`, and `ADMIN_LOGOUT_ALL` events. Revoked sessions count one for each `SESSION_REVOKED`, `SESSION_AUTO_REVOKED`, or `ADMIN_SESSION_REVOKED`; logout-all events add their actual stored `revokedCount`. Alerts count once per current alert Hash by `createdAtMs` and severity; read/resolution events do not create extra alerts. Unknown event types do not contribute. Empty calendar days in the chosen range are emitted as zero rows, not as invented event records.

### CSV safety and limits

Files use a UTF-8 BOM, comma separator, CRLF row endings, a header, and quoted/escaped fields. Times are formatted `YYYY-MM-DD HH:mm:ss +07:00` (`Asia/Ho_Chi_Minh`). Excel formula-like values beginning with whitespace/control characters followed by `=`, `+`, `-`, or `@` are prefixed with an apostrophe before CSV quoting. This mitigates common spreadsheet formula injection; CSV import behavior varies by spreadsheet application, so it is not a universal guarantee. Embedded commas, quotes, and line breaks remain correctly quoted.

An empty history or alert result downloads a header-only CSV and the UI says that no matching data was found. The defaults are `EXPORT_MAX_ROWS=5000`, `EXPORT_MAX_SCAN=50000`, a 15-second query time limit, and 10 report requests per account per minute. A result or scan that exceeds its limit returns a JSON `413` error; it is never silently truncated. To preserve cursor correctness, more than 1,000 alerts with the exact same creation millisecond also returns a clear `413` instead of skipping tied records. Bad filters return `400`, an unauthenticated request returns `401`, a USER calling an Admin route gets `403`, and report-source failures return JSON `503` rather than a CSV download. Each export captures the current Stream upper boundary; alert indexes are traversed by score/ID cursor. Redis does not provide a transaction snapshot across these report reads, so a concurrent alert creation/expiry can affect which rows appear during that request.

Audit events and alerts are subject to their existing Redis retention and cleanup policies (normally 30 days). Audit writing is best-effort in existing login/session flows; missing audit events cannot be reconstructed by reports. When the configured audit or alert retention is shorter than the selected dates, only the records still present in Redis can be counted. Daily metrics are therefore a summary of retained records, not a claim of complete historical activity.

### Demo and tests

1. Sign in as USER and open **Báo cáo & Xuất dữ liệu** from the sidebar. Export personal history, alerts, and daily summary; check that the Admin account field is absent.
2. Sign in as ADMIN and export global data, then enter a user's Redis ID in the account filter and export again.
3. Open the downloaded CSV in Excel. The BOM supports Vietnamese text; check the `+07:00` timestamp and the selected date range.
4. In Redis Insight, compare history with `audit:auth:global` / `audit:auth:user:<userId>` and compare alerts with `security:alerts:global`, `security:user:alerts:<userId>`, and their `security:alert:<alertId>` Hashes. Summary counts use those same sources.
5. Run `npm run test:e2e:all` for Chromium download tests and Node integration/regression tests. The runner uses only its disposable Redis at `127.0.0.1:16380` and backend port `3100`; do not point tests at the project Redis on port `6380`.

Integration coverage is in `test/reportExports.test.js` (EX-TC-01 through EX-TC-28). Browser download checks are in `e2e/reports.spec.js`. The HTML report is written to `playwright-report/` by the existing E2E runner.

## Durable Firebase / Firestore storage

The app can keep Redis as the live authentication store and optionally mirror durable information to Cloud Firestore. Redis remains authoritative for password verification, session validity, session revocation, and temporary login locks. Firestore stores an allowlisted user profile, retained authentication/security activity, login totals, and session history. Password hashes, cookie values, raw Redis session IDs, and management IDs are never written to Firestore.

### Configure

1. Create a Firebase project and enable Cloud Firestore in Native mode.
2. Install dependencies with `npm install` (includes `firebase-admin`).
3. Copy `.env.example` to `.env`, set `FIRESTORE_SYNC_ENABLED=true` and `FIREBASE_PROJECT_ID`.
4. For local Windows development, set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON stored outside the repository. On Google Cloud, use the runtime service identity / Application Default Credentials instead. Grant the identity only the required Firestore access.
5. Keep `FIRESTORE_SOURCE_EPOCH` unchanged while using the same Redis dataset. Change it after replacing/restoring Redis in a way that resets its Stream history. Set a long random `FIRESTORE_SESSION_REF_KEY` if stable HMAC references across app restarts are required; existing session references are stored in Redis and are not recalculated.
6. Start Redis, then run `npm start`. The Firestore worker resumes after its saved checkpoint and polls `audit:auth:global` and `security:alerts:events`.

With `FIRESTORE_SYNC_ENABLED=false` or unset, the app behaves as the Redis-only demo. When enabled, profile writes happen after successful authentication; a background worker stores stream events using Firestore transactions, receipts, and per-stream checkpoints. The same event can be retried safely. Firestore write errors are logged and the worker retries from its last committed checkpoint; the login/session request remains governed by Redis.

### Data boundary and delivery limits

The worker creates `users`, `activity_events`, `session_history`, `user_auth_stats`, `system_auth_stats`, `auth_event_receipts`, and `auth_sync_checkpoints`. Session history uses an HMAC reference stored in the Redis session hash; end events and logout-all carry only those opaque references. No heartbeat snapshots are written yet, so `last_seen_at` is the session creation time. Existing Redis audit Streams are trimmed after their configured retention (30 days by default); a worker outage longer than that window can leave an unrecoverable gap. This async branch is durable after Firestore commit, but it does not make the Redis-to-Firestore handoff lossless across Redis data loss. For that guarantee, enable and verify Redis persistence/backups or move the durable journal write into the synchronous business operation.

Firestore indexes and TTL policies still need deployment/configuration in the Firebase project. Service account JSON files must stay out of Git; `.gitignore` excludes the common key-file names.
