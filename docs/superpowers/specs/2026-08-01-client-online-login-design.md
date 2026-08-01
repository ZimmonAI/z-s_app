# Z-s Client Online Login Design

## Status

Draft for user review. No runtime code, migration, live database schema, or secret file has been changed by this document.

## Context read

- Governance entry: `D:/zimspace/z-kn/vault-rule.md` was already established as the discovery boundary for this work.
- UI system: `D:/zimspace/apps/z-s_app/DESIGN.md`.
- Current operator login/runtime wrapper: `D:/zimspace/apps/z-s_app/src/control-plane-ui.ts` and `D:/zimspace/apps/z-s_app/src/runtime-control-composition.ts`.
- Current request parsing and abuse controls: `D:/zimspace/apps/z-s_app/src/control-plane-ui-request.ts`, `D:/zimspace/apps/z-s_app/src/control-plane-ui-abuse.ts`, and `D:/zimspace/apps/z-s_app/src/node-http-adapter.ts`.
- Pending storage-control schema: `D:/zimspace/apps/z-s_app/db/migrations/0004_z_s_storage_control_vaults.sql`.
- Current Video Maker bootstrap seed: `D:/zimspace/apps/z-s_app/db/seeds/0001_video_maker_dev_profiles.sql`.
- Prior storage-control design: `D:/zimspace/apps/z-s_app/docs/superpowers/specs/2026-07-30-storage-vault-routing-and-image-resize-design.md`.

## Problem

Z-s currently has an operator-only browser control login. That login protects the admin storage planner with an environment-backed operator password and a signed `zs_control_session` cookie. Runtime app access is separate and already uses bearer-token style client authentication for callers such as `video-maker_app`.

The next requirement is an online client login/account surface for Z-s, with `video-maker_app` as the first client account. The client login must not weaken the existing operator/admin boundary, must not store raw client secrets, and must align with the pending storage-control schema instead of creating a parallel identity model.

## Design decision

Use the DB-backed storage-control client tables as the credential authority for online client accounts:

- `storage_control_clients` is the client account record.
- `storage_control_client_tokens` is the digest-only credential record.
- `video-maker_app` becomes the first `storage_control_clients.client_id` account.

The operator/admin login remains separate. Operators use `/login` and `/admin/session`; clients use a new client-facing login/session namespace. Runtime bearer tokens remain runtime credentials and are not exposed as reusable browser session cookies.

This decision matches the existing `0004` schema, keeps the first account scalable beyond `video-maker_app`, and avoids a temporary env-only account path that would need to be removed later.

## Approaches considered

### A. DB-backed client account and digest-only token login

Create or seed `video-maker_app` in `storage_control_clients`, authenticate client login attempts against active, unexpired token digests in `storage_control_client_tokens`, and issue a separate signed browser cookie for the client control surface.

Tradeoffs:

- Aligns with the pending schema and digest-only persistence.
- Supports revocation, expiry, disabled accounts, and future client accounts.
- Requires a small client session layer distinct from the existing operator session.
- Depends on migration `0004` being available before DB-backed login can operate live.

Recommended.

### B. Env-backed first client account

Add environment variables for `video-maker_app` client login and issue a browser session after comparing the submitted passphrase.

Tradeoffs:

- Fastest local bootstrap.
- Avoids relying on live migration state.
- Creates a second temporary credential authority that conflicts with `0004`.
- Does not naturally support token revocation, expiry, or multi-client management.

Rejected for this feature because it duplicates identity authority and would be technical debt immediately.

### C. External identity provider boundary

Reserve client login routes for a future SSO/OIDC provider and do not create local client credentials.

Tradeoffs:

- Clean enterprise shape later.
- Avoids storing local login credentials.
- Does not satisfy the immediate need for `video-maker_app` to have an account now.
- Adds integration complexity without a named provider or tenant model.

Rejected for now. The local DB-backed account model can later become the account lookup behind an external identity binding.

## Proposed architecture

### Separate session namespaces

Operator and client browser sessions use different cookies, subjects, and routes.

- Existing operator cookie: `zs_control_session` with subject `z-s-control`.
- New client cookie: `zs_client_session` with subject shaped as `z-s-client:<client_id>`.
- Operator routes remain under `/admin/*`.
- Client routes live under `/client/*`.

This avoids privilege confusion. A valid client session never authorizes `/admin/storage`; a valid operator session never silently impersonates a client.

### Client routes

Initial client surface:

- `GET /client/login`: render the client login page.
- `POST /client/session`: authenticate a client credential.
- `DELETE /client/session`: clear the client browser session.
- `GET /client`: redirect to the client account home if authenticated, otherwise `/client/login`.
- `GET /client/storage`: authenticated client storage-control page scoped to the session client.

The first implemented client page can start as an account/storage landing page for `video-maker_app`. It should show the authenticated client id and safe storage-control navigation. It should not expose raw runtime bearer tokens, token digests, provider secrets, object keys, or secret references beyond already-approved safe labels.

### Client credential form

The client login form accepts:

- `clientId`, with `video-maker_app` as the first expected account.
- `clientCredential`, a one-time-visible passphrase/token value submitted by the user.

The server hashes the submitted credential with SHA-256 and compares it to active `storage_control_client_tokens.token_digest` rows for the client account. It only accepts rows where:

- `storage_control_clients.status = 'active'`;
- `storage_control_client_tokens.status = 'active'`;
- `expires_at IS NULL OR expires_at > now()`.

The raw credential is never persisted or returned.

### First account bootstrap

`video-maker_app` is the first online client account:

- `storage_control_clients.client_id = 'video-maker_app'`.
- `display_label = 'Video Maker'`.
- `status = 'active'`.
- At least one active token row is created with `token_purpose = 'browser-login'` or the existing planner-safe purpose naming convention if implementation finds a stricter local pattern.

The bootstrap must be explicit and safe. If migration `0004` is not applied, the client login page should show a not-configured state instead of falling back to env credentials.

### Reuse existing safety controls

The client login should mirror the operator surface controls:

- bounded request bodies;
- no-store responses;
- signed, HttpOnly, SameSite=Lax cookies;
- secure cookies on HTTPS;
- rate limiting for failed login attempts;
- constant-time digest comparison where applicable;
- JSON error bodies for JSON clients and HTML error pages for browser form posts.

The existing operator abuse limiter can be reused as a pattern, but client failures should be tracked separately from operator failures so one surface does not lock the other.

## UI design

The client login follows `DESIGN.md`:

- native form controls only;
- system colors and existing CSS variables;
- one `<main>` and one `<h1>`;
- label-above-input layout;
- clear unauthenticated, authenticated, and not-configured states;
- no custom dropdowns or JavaScript requirement.

Client copy should use client language, not operator language. For example, the heading should be `Client login` or `Z-s client account`, not `Operator control`.

The `video-maker_app` account should be visible as the initial account identity after login, but secrets and token material must not be displayed.

## Data flow

1. User opens `/client/login`.
2. Server renders the client login form if DB-backed client login is configured and `0004` tables are reachable.
3. User posts `clientId` and `clientCredential` to `/client/session`.
4. Server finds the active `storage_control_clients` row by `client_id`.
5. Server hashes the submitted credential and checks it against active, unexpired token digests for that client.
6. On success, server issues `zs_client_session` with the client id and expiry.
7. Browser redirects to `/client/storage` or returns `204` for JSON requests.
8. Authenticated client pages scope all account behavior to the client id inside the signed session.

## Error handling

Client login errors use stable, non-secret codes:

- `client-login-not-configured`: DB-backed client login is unavailable or migration `0004` tables are missing.
- `invalid-client-credential`: client id or credential did not authenticate.
- `client-login-rate-limited`: too many failed attempts.
- `client-session-required`: a client page was requested without a valid client session.
- `client-disabled`: account exists but is disabled.

The login page may show these as human-readable messages, but responses must not reveal whether a specific unknown client id exists. For browser login failures, `invalid-client-credential` is the default public failure.

## Security boundaries

- Operator and client sessions are not interchangeable.
- Client login cannot authorize `/admin/*`.
- Operator login is not changed by this feature.
- Token digests are stored; raw client credentials are not stored.
- Runtime bearer tokens are not printed in HTML, JSON responses, logs, tests, or previews.
- Secret references remain references only; provider secret values stay outside the database and UI.
- `video-maker_app` starts as the first client account, not a hardcoded special case in route authorization.

## Testing and verification

Implementation should add focused tests for:

- `GET /client/login` renders unauthenticated form when configured.
- `POST /client/session` authenticates the seeded `video-maker_app` browser-login credential.
- invalid credential returns a generic failure and does not issue a cookie.
- client session cannot access `/admin/storage`.
- operator session cannot access `/client/storage` unless a client session also exists.
- disabled or expired client token cannot log in.
- oversized client login body returns the body-limit error.
- rate limiting applies to client login attempts separately from operator login attempts.
- not-configured state is shown when the client tables are unavailable.

Manual QA should drive the browser surface:

- open `/client/login`;
- submit one bad credential and observe the safe error;
- submit the `video-maker_app` credential from the authorized secret/bootstrap source;
- confirm redirect to `/client/storage`;
- confirm `/admin/storage` remains unavailable without operator login;
- delete the client session and confirm `/client/storage` redirects back to `/client/login`.

## Out of scope

- External SSO/OIDC integration.
- Password reset or email invitation flows.
- Multi-tenant branding beyond showing the authenticated client label.
- Exposing raw runtime bearer tokens in the browser.
- Applying live migration `0004`; that remains a separate operational decision.
- Replacing the existing operator/admin login.

## First credential handling

The first `video-maker_app` browser-login credential is created outside the repository and outside this design document. The implementation uses a local bootstrap command that receives the credential through an authorized secret channel, stores only its SHA-256 digest in `storage_control_client_tokens.token_digest`, and never prints the raw credential.

The bootstrap command may print non-secret confirmation fields only:

- `client_id`;
- `token_id`;
- `token_purpose`;
- token status;
- expiry, if configured.

The raw credential delivery path remains an operational secret-management action, not a Z-s HTTP response, log line, seed literal, test fixture, or committed file.
