const reports = require('./reportService');

const QUERY_TIMEOUT_MS = 15_000;
const REQUESTS_PER_MINUTE = 10;
const requestWindows = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  for (const [id, window] of requestWindows) if (window.expiresAt <= now) requestWindows.delete(id);
  const window = requestWindows.get(userId);
  if (!window || window.expiresAt <= now) {
    requestWindows.set(userId, { count: 1, expiresAt: now + 60_000 });
    return true;
  }
  if (window.count >= REQUESTS_PER_MINUTE) return false;
  window.count += 1;
  return true;
}

function reportConfig(kind, filters) {
  if (kind === 'history') {
    return {
      filename: `lich-su-hoat-dong-${reports.fileDate()}.csv`,
      headers: ['STT', 'Thời gian (Asia/Ho_Chi_Minh)', 'Tài khoản', 'Loại sự kiện', 'Kết quả', 'Thiết bị', 'Địa chỉ IP', 'Mô tả'],
      rows: reports.historyCsvRows,
      load: () => reports.buildHistory(filters),
    };
  }
  if (kind === 'security') {
    return {
      filename: `canh-bao-bao-mat-${reports.fileDate()}.csv`,
      headers: ['STT', 'Mã cảnh báo', 'Thời gian tạo (Asia/Ho_Chi_Minh)', 'Tài khoản', 'Loại cảnh báo', 'Nguyên nhân', 'Mức độ', 'Thiết bị', 'Địa chỉ IP', 'Trạng thái', 'Đã đọc', 'Thời gian xử lý (Asia/Ho_Chi_Minh)', 'Người xử lý', 'Kết quả xử lý'],
      rows: reports.alertCsvRows,
      load: () => reports.buildSecurity(filters),
    };
  }
  return {
    filename: `thong-ke-hoat-dong-${reports.fileDate()}.csv`,
    headers: ['Ngày (Asia/Ho_Chi_Minh)', 'Đăng nhập thành công', 'Đăng nhập thất bại', 'Khóa đăng nhập', 'Đăng xuất', 'Thu hồi phiên', 'Tổng cảnh báo', 'HIGH', 'LOW', 'MEDIUM'],
    rows: (values) => values,
    load: () => reports.buildSummary(filters),
  };
}

function exportReport(kind, admin = false) {
  return async (req, res) => {
    const userId = admin ? req.admin.userId : req.session.userId;
    if (!checkRateLimit(`${admin ? 'admin' : 'user'}:${userId}`)) {
      return res.status(429).json({ success: false, message: 'Đã đạt giới hạn 10 lượt xuất trong một phút. Vui lòng thử lại sau.' });
    }
    let timeout;
    try {
      const filters = reports.validateFilters(req.query, { admin, kind });
      const scopedFilters = admin ? filters : { ...filters, userId };
      const config = reportConfig(kind, scopedFilters);
      const queryPromise = config.load();
      const data = await Promise.race([
        queryPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new reports.ReportError('Truy vấn báo cáo vượt thời gian 15 giây; hãy thu hẹp bộ lọc', 503, 'EXPORT_TIMEOUT')), QUERY_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
      clearTimeout(timeout);
      const csv = reports.toCsv(config.headers, config.rows(data));
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${config.filename}"`,
        'Cache-Control': 'no-store',
        'X-Report-Empty': String(data.length === 0),
      });
      return res.status(200).send(csv);
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof reports.ReportError) {
        return res.status(error.status).json({ success: false, code: error.code, message: error.message });
      }
      console.error(`[GET report export:${kind}]`, error.message);
      return res.status(503).json({ success: false, code: 'REPORT_SOURCE_UNAVAILABLE', message: 'Không thể đọc dữ liệu báo cáo từ Redis. Vui lòng thử lại sau.' });
    }
  };
}

module.exports = { exportReport };
