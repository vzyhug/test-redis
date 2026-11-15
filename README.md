# test-redis

Tài liệu thiết kế Backend API, Firestore và Redis cho quản lý đăng nhập.

- [Kiến trúc hệ thống](architecture.md)
- [Thiết kế dữ liệu Redis: tài khoản, phiên đăng nhập, thống kê, online và lịch sử](redis-data-design.md)
- [Thiết kế Firestore và đồng bộ với Redis](firestore-data-design.md)
- [Cấu hình indexes Firestore đề xuất, chưa deploy](firestore.indexes.json)
- [Lệnh Redis theo thiết kế (.txt)](redis-commands.txt)
- [Hướng dẫn kết nối Firestore, Redis và RedisInsight Desktop trên Windows (.txt)](data-setup-guide.txt)

## Redis Session Management Demo

The runnable application source and setup instructions are in [README-app.md](README-app.md).

## Trạng thái nhánh Firebase

Ứng dụng có nhánh đồng bộ Firestore tùy chọn để lưu hồ sơ, audit/security events, thống kê đăng nhập và lịch sử phiên. Redis vẫn quyết định phiên đang hiệu lực và thu hồi phiên. Bật nhánh này theo hướng dẫn **Durable Firebase / Firestore storage** trong `README-app.md`; mặc định nó tắt để giữ cách chạy demo Redis hiện tại. Tài liệu Firestore và indexes mô tả schema đích; indexes/TTL vẫn cần cấu hình trên Firebase project.

