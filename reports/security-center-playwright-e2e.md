# Security Center Playwright E2E report

**Run date:** 2026-10-30  
**Readiness:** **READY WITH LIMITATIONS** for the tested flows. All runnable Playwright cases and Node regressions pass; genuine second-source-IP browser coverage remains NOT RUN.

## Environment and isolation

| Component | Verified environment |
|---|---|
| Node.js | v25.9.0 |
| Playwright | 1.64.1 |
| Browser used | Chromium 156.0.8078.4, headless |
| Redis | Redis 7.2.16, ephemeral container, host bind `127.0.0.1:16380` |
| Backend | `http://127.0.0.1:3100`, started by Playwright `webServer` |
| Browser viewport | 1366×768 default; responsive test also used 768×1024 and 375×812 |

The E2E runner first checked ports 16380 and 3100 were free, started a fresh labeled Redis container with no mounted volume, verified Redis 7.2.16 and PING, and set the backend's explicit `REDIS_URL` and `PORT`. E2E accounts were randomly generated and bcrypt-hashed directly into that test Redis. No E2E seed or test connected to the project Redis on port 6380 or reused the project backend on port 3000. The runner removed its test container after the run. The project's port 6380 data was not read or modified.

All E2E browser flows used the real Express backend, real Redis, and browser UI; no API responses were mocked. Test accounts were randomly generated and bcrypt-hashed at cost 10 directly into the disposable Redis. E2E-25 deliberately aborted one alerts request to exercise the UI's network-error state.

## Files added or changed

| File | Purpose |
|---|---|
| `playwright.config.js` | Isolated backend URL, serial Chromium project, HTML reporter, screenshots and traces on failure. |
| `scripts/e2eRunner.js` | Port preflight, disposable Redis lifecycle, version check, Playwright run, optional Node regression run, cleanup. |
| `e2e/auth.spec.js` | Login, access control, navigation, responsive UI, loading/error, browser errors, data leakage. |
| `e2e/security-detection.spec.js` | Baseline, known/new environment, deduplication, lockout. |
| `e2e/security-user.spec.js` | USER alerts, read/resolve/revoke, ownership, Origin, Redis consistency. |
| `public/security.js` | Safe-resolution captures its button and alert ID before awaiting confirmation; prevents duplicate submissions and restores the button on cancel/API errors. |
| `public/script.js` | Logout-all captures the button before confirmation and guards the pending action until cancellation, failure, or completion. |
| `e2e/security-admin.spec.js` | System-wide view, filters, ADMIN resolution/revocation, remote session revoke. |
| `e2e/helpers/*` | Test-only accounts, isolated Redis access, UI and alert helpers. |
| `server.js` | Minimal port configuration: `PORT` environment variable, default remains 3000. |
| `package.json`, `package-lock.json` | `@playwright/test` dev dependency and E2E scripts. |
| `.gitignore` | Excludes generated Playwright results, reports, and auth state. |
| `README.md` | E2E setup, commands, test isolation, and limitations. |

## E2E-01 through E2E-28 plus regression checks

| Test ID | Coverage | Result | Evidence |
|---|---|---|---|
| E2E-01 | USER login, `/api/me`, and Redis session/index | PASS | `e2e/auth.spec.js` |
| E2E-01a | USER cancels logout-all, then confirms once; session index is cleared | PASS | `e2e/auth.spec.js` |
| E2E-02 | ADMIN login and admin navigation/page | PASS | `e2e/auth.spec.js` |
| E2E-03 | USER denied admin page/API and data | PASS | `e2e/auth.spec.js` |
| E2E-04 | First login creates baseline without alert | PASS | `e2e/security-detection.spec.js` |
| E2E-05 | Known environment does not alert | PASS | `e2e/security-detection.spec.js` |
| E2E-06 | New controlled Safari/iPhone User-Agent creates alert | PASS | `e2e/security-detection.spec.js` |
| E2E-07 | Repeat of same environment is deduplicated | PASS | `e2e/security-detection.spec.js` |
| E2E-08 | Detection from two real source IPs | NOT RUN | A local browser run cannot create two genuine source IPs without a proxy/network change. No fake success was claimed. |
| E2E-09 | Fifth bad login, HTTP 429, one HIGH alert | PASS | `e2e/security-detection.spec.js` |
| E2E-10 | USER list is scoped to own alerts | PASS | `e2e/security-user.spec.js` |
| E2E-11 | USER alert detail and sensitive-data checks | PASS | `e2e/security-user.spec.js` |
| E2E-12 | Mark read survives reload and stays OPEN | PASS | `e2e/security-user.spec.js` |
| E2E-13 | USER safe confirmation, cancellation, disabled button, one request, Redis unchanged sessions | PASS | `e2e/security-user.spec.js` |
| E2E-13a | API conflict after confirmation displays an error and restores the button | PASS | `e2e/security-user.spec.js` |
| E2E-14 | USER revokes related session; own session remains | PASS | `e2e/security-user.spec.js` |
| E2E-15 | Inactive related session is not reported revoked | PASS | `e2e/security-user.spec.js` |
| E2E-16 | ADMIN views alerts from multiple accounts | PASS | `e2e/security-admin.spec.js` |
| E2E-17 | ADMIN filters by type, severity, status, and account | PASS | `e2e/security-admin.spec.js` |
| E2E-18 | ADMIN confirms USER alert safe; actor/status reflected | PASS | `e2e/security-admin.spec.js` |
| E2E-19 | ADMIN revokes related USER session; ADMIN session remains | PASS | `e2e/security-admin.spec.js` |
| E2E-20 | USER A cannot read or mutate USER B alert | PASS | `e2e/security-user.spec.js` |
| E2E-21 | Missing and cross-origin Origin are rejected | PASS | `e2e/security-user.spec.js` |
| E2E-22 | Remote revoke invalidates next protected request | PASS | `e2e/security-admin.spec.js` |
| E2E-23 | Sidebar links and role-specific menu | PASS | `e2e/auth.spec.js` |
| E2E-24 | Desktop, tablet, mobile viewport and drawer | PASS | `e2e/auth.spec.js` |
| E2E-25 | Loading, empty, and request-error UI states | PASS | `e2e/auth.spec.js` |
| E2E-26 | Main page flow has no uncaught JS/request errors | PASS | `e2e/auth.spec.js` |
| E2E-27 | No password, cookie, auth Session ID, or cross-user data leak | PASS | `e2e/auth.spec.js` |
| E2E-28 | API/UI/Redis indexes, events, and safe-resolution consistency | PASS | `e2e/security-user.spec.js` |

**Playwright total:** 30 tests; 29 passed, 0 failed, 1 skipped.  
**Node.js regression:** 102 passed, 0 failed, 0 skipped.

## Bug report

### SC-E2E-001 — Safe-resolution UI threw after confirmation — FIXED

- **Severity:** High for the alert-handling feature.
- **Affected cases:** E2E-13, E2E-18, and E2E-28; the shared USER/ADMIN UI handler is used in each.
- **File:** `public/security.js`.
- **Precondition:** An authenticated USER or ADMIN opens an `OPEN` alert detail.
- **Steps:** Click **Xác nhận an toàn**, then confirm in the dialog.
- **Expected:** A PATCH to the matching `/api/.../alerts/:alertId/resolve` endpoint succeeds; the alert becomes `RESOLVED_SAFE`, with actor, timestamp, and event history.
- **Cause:** The async click handler read `event.currentTarget` after awaiting `window.appConfirm(...)`, when the DOM event's `currentTarget` was null.
- **Fix:** Capture the button and selected alert ID before awaiting. Disable the button while the confirmation is pending, prevent duplicate attempts, and restore it on cancel or API failure. The session logout-all handler had the same `currentTarget` timing bug; it now captures the button before awaiting and is covered by E2E-01a.
- **Verification:** E2E-13, E2E-13a, E2E-18, and E2E-28 passed; E2E-01a also verifies logout-all cancellation and a single confirmed request. Node SC-TC-15 passed as part of all 102 Node regressions.

## Limits and browser status

- E2E-08 did not test new-IP detection from a genuine second source IP. Existing integration tests cover the IP comparison logic, but do not replace this missing browser-network case.
- New-environment E2E uses a separate Chromium context with a controlled Safari/iPhone User-Agent; it proves the real request/backend/Redis flow for a changed User-Agent, not a second browser engine or physical device.
- Firefox installation was attempted, but a local smoke launch failed with `browser.newPage: Target crashed`; Firefox was therefore not counted as tested.
- E2E-25 tests the frontend error state by aborting the real request, rather than inducing an HTTP 500 from Redis/backend.
- HTML report: `playwright-report/index.html`. Validation summary: `reports/security-center-playwright-terminal.log`. Failure screenshots, video, traces, and contexts: `test-results/` (ignored by Git); the final run had no failing cases.
- `npm install` reported 4 dependency audit findings (1 moderate, 2 high, 1 critical); this E2E task did not triage or change those dependencies.

## Rerun commands (Windows PowerShell)

```powershell
npm install
npx playwright install chromium
npm run test:e2e:all
npm run test:e2e:report
```

`test:e2e:all` refuses occupied ports 16380/3100, creates its own no-volume Redis container, uses only Redis `127.0.0.1:16380`, runs Playwright and `node --test`, then removes only that run's labeled container. Do not substitute port 6380.
