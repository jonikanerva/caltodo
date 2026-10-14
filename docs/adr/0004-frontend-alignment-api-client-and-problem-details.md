# ADR 0004: Frontend alignment, the generated API client, and Problem Details

- Status: accepted
- Date: 2026-10-14

## Context

The client was a Vite app in `client/` with Wouter, hand-written `fetch` calls, and types from `shared/`, which the Node server also used. ESLint and Knip checked it. The Node server answered an API failure with `{"error": "<text>"}` or `{"message": "<text>"}`.

Owner decision (P1): full alignment with `STACK-RUST.md`, with no visible change to the user interface.

## Decision

1. The web app moves to `web/` in a pnpm workspace with `packages/api-client` and `e2e/`. It uses TypeScript 7, Vite 8, Vitest 5, TanStack Router (with the same URLs), and TanStack Query. Oxlint with type-aware rules replaces ESLint and Knip. The strict compiler flags of `STACK.md` §1 apply.
2. `contract/openapi.json` is the API contract. utoipa and utoipa-axum export it from the registered Rust routes. Hey API 0.99 generates the SDK, the types, and the Zod validators into `packages/api-client/src/generated/`. A small facade (`packages/api-client/src/index.ts`) validates every success body and every error body, sends the CSRF token, and maps failures to `ApiError`. The web app calls the API only through the facade.
3. Every `/api` failure is RFC 9457 Problem Details (`application/problem+json`) with a stable `code` and a fixed `detail`. The `detail` keeps the old error text where one existed, for example "No free time slots available in the next 90 days.". `STACK.md` §2.2 lists the codes.
4. The action pages (`/action/{token}`) stay server-rendered HTML with the same markup as the Node pages.
5. The visible interface does not change. The evidence is a pixel comparison of 13 screens of the old and the new build (`e2e/visual-compare/`) and the Playwright journeys.

## Alternatives

- **Keep the client as it is and change only the server.** Rejected by the owner (P1).
- **Keep the old error bodies.** Rejected: the profile requires Problem Details, and only the first-party client reads the bodies. The client shows fixed texts, so the user sees no change.

## Consequences

- The error format of the API changes. No other client uses the API.
- An open browser tab of the old client keeps working with fixed error texts until it reloads. Its sign-in is gone after the release (ADR 0002), so the tab shows the sign-in page after its next API call.
- The generator needs TypeScript 6 and an override of js-yaml (`STACK.md` §13).
- 30 unused shadcn/ui components, an unused page, and unused hooks are removed. They were not reachable from any route.
