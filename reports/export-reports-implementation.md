# Export Reports implementation report

**Date:** 2026-10-30  
**Status:** Implemented; all required export tests passed.

## Scope

| Requirement | Status | Delivered behavior |
|---|---|---|
| EX-01 Activity history | PASS | USER reads their own audit Stream; ADMIN reads the global Stream and may filter by account/event/date. |
| EX-02 Security alerts | PASS | Reads the current alert Hashes selected by existing user/global Sorted Set indexes; filters by severity, status, type, account, and date. |
| EX-03 Daily summary | PASS | Counts retained audit events and current alert records by Vietnam calendar day. |
| EX-04 Filters and date range | PASS | Defaults to seven Vietnam days; validates dates and caps a request at 30 inclusive dates. |
| EX-05 Access and CSV safety | PASS | Existing authentication/Admin middleware; USER identity comes from session; CSV values are quoted and formula-like text is apostrophe-prefixed. |
| EX-06 CSV download | PASS | UTF-8 BOM, attachment response, date/time with `+07:00`, empty header-only reports, and browser download flow. |

## Files

- `src/reportService.js`: filters, bounded Redis reads, history/alert/summary calculation, Vietnam time formatting, CSV encoding, and export limits.
- `src/reportController.js`: export response headers, download naming, per-account rate limit, timeout, and JSON error responses.
- `server.js`: authenticated report page and USER/ADMIN export routes.
- `src/securityService.js`: exposes the existing Alert Hash mapper for safe reuse by the report service.
- `public/reports.html`, `public/reports.js`, `public/style.css`, `public/app.js`: responsive report page, filters, download/error/empty/expired-session states, shared navigation.
- `test/reportExports.test.js`: 28 Redis-backed API/integration tests.
- `e2e/reports.spec.js`: six browser download, content, filtering, responsive, empty/error, and expired-session scenarios.
- `README.md`: source schema, endpoint/filter reference, metric definitions, CSV limits/security, demo, and known limitations.

## API

All routes are `GET`; successful responses are `text/csv; charset=utf-8` with `Content-Disposition: attachment`.

| Endpoint | Permission | Query parameters |
|---|---|---|
| `/api/reports/history/export` | Authenticated USER/ADMIN; always personal data | `from`, `to`, `eventType`; `userId` is rejected |
| `/api/reports/security/export` | Authenticated USER/ADMIN; always personal data | `from`, `to`, `severity`, `status`, `alertType`; `userId` is rejected |
| `/api/reports/summary/export` | Authenticated USER/ADMIN; always personal data | `from`, `to`; `userId` is rejected |
| `/api/admin/reports/history/export` | ADMIN | `from`, `to`, `eventType`, optional exact `userId` |
| `/api/admin/reports/security/export` | ADMIN | `from`, `to`, `severity`, `status`, `alertType`, optional exact `userId` |
| `/api/admin/reports/summary/export` | ADMIN | `from`, `to`, optional exact `userId` |

Dates use `YYYY-MM-DD`, are inclusive in `Asia/Ho_Chi_Minh`, default to the latest seven calendar days, and are limited to 30 inclusive days. Errors are JSON: invalid request `400`, unauthenticated `401`, non-Admin `403`, result/scan cap `413`, and report Redis/query failure `503`.

## Data and CSV

History reads only `audit:auth:user:<userId>` for a personal export or `audit:auth:global` for an Admin export. It uses the existing `auditService.EVENT_TYPES` and stored fields; unknown events are skipped. The global Stream is used once, avoiding a union of duplicate actor/user Stream copies.

Alerts use `security:user:alerts:<userId>` or `security:alerts:global` and read the current `security:alert:<alertId>` Hash for status, read time, resolution time, actor, and result. Expired/missing Hashes are omitted. Export is read-only apart from normal authentication middleware session TTL refresh.

Daily counters are defined in README: `LOGIN_SUCCESS`, `LOGIN_FAILED`, and `LOGIN_LOCKED` count their events; logout actions count `LOGOUT`, `LOGOUT_ALL`, and `ADMIN_LOGOUT_ALL`; revoked sessions count explicit revoke events and the actual `revokedCount` on logout-all; alerts count once by creation time and severity. Read/resolution state changes do not create additional alert counts. Empty days appear as zero rows.

History CSV has eight columns, alert CSV fourteen, and summary CSV ten. All fields are quoted; commas, quotes, CR/LF are escaped as CSV. Formula-like text is apostrophe-prefixed. UTF-8 BOM aids Excel Windows; timestamp format is `YYYY-MM-DD HH:mm:ss +07:00`. This is a common CSV formula mitigation, not a guarantee across every spreadsheet importer.

Default safety limits: 5,000 output records, 50,000 scanned records, 15 seconds per report, and 10 export requests per account per minute. Exceeding a row/scan limit returns JSON `413`; no partial CSV is presented as complete. Requests with no history/alert matches download a header-only CSV. Summary still emits zero-valued dates for the selected range.

## Test results

Command: `npm run test:e2e:all`

- Node.js: **130 passed, 0 failed, 0 skipped**. This includes **EX-TC-01 through EX-TC-28: 28 passed** and 102 existing regression tests.
- Playwright: **36 total; 35 passed, 0 failed, 1 skipped**. Six Export Reports browser scenarios passed.
- E2E-08 remains NOT RUN because this local runner cannot provide a genuine second source IP.
- Test Redis was a disposable Redis 7.2 container bound only to `127.0.0.1:16380`; the backend used port `3100`. Runner cleanup removed its container. Project Redis `6380` and app backend `3000` were not used.
- Latest browser report: `playwright-report/index.html`. No failing screenshots/traces were produced in the final run.

## Demo

1. Start project Redis and run `npm start`; sign in as USER.
2. Open **Báo cáo & Xuất dữ liệu**. Export history, alerts, and daily summary; verify no account filter is shown.
3. Sign in as ADMIN. Export global history/alerts/summary, then enter an account's `userId` to filter.
4. Open the CSV with Excel and check Vietnamese text, headers, selected range, and `+07:00` timestamps.
5. Compare data in Redis Insight against `audit:auth:global`, `audit:auth:user:<userId>`, `security:alerts:global`, `security:user:alerts:<userId>`, and the matching `security:alert:<alertId>` Hashes.

## Limitations

- Reports reflect data still retained in Redis. Audit writes are best-effort in existing flows, so missing events cannot be reconstructed.
- Redis reads do not create a transaction snapshot across Streams, indexes, and alert Hashes. The Stream upper boundary is fixed for each request; concurrent alert insertion/cleanup can affect the alert result during export.
- An alert index containing more than 1,000 entries at one exact millisecond is rejected with `413` rather than risk a missing/tied cursor row.
- CSV spreadsheet formula mitigation differs across applications and is not an absolute guarantee.
- Genuine two-source-IP browser coverage remains NOT RUN (E2E-08).
