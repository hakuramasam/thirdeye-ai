# ThirdEye AI — Cloudflare staging

## Current state

This branch adds a separate Cloudflare Worker entry point and static asset binding. It is intentionally a **safe staging shell**, not a claim that the full Node.js API has been migrated.

- Worker name: `thirdeye-ai-staging`
- Source: `src/worker.ts`
- Frontend assets: `web/dist`
- Wrangler config: `wrangler.jsonc`
- Liveness: `GET /api/livez`
- Readiness: `GET /api/healthz` (503 until isolated staging DB integration)
- Other API routes: fail closed with 503
- Live payments: disabled
- Production agent execution: disabled
- Database writes: disabled

## Build and test

```sh
npm ci
npm run build:web
npx wrangler deploy --dry-run
npx tsx --test tests/cloudflare-worker.test.ts
```

## Hyperdrive is intentionally not provisioned yet

The Cloudflare account currently has no Hyperdrive configurations. Do not connect this staging Worker to a production database. Before creating a Hyperdrive configuration, provision a separate staging PostgreSQL database/branch and provide its connection details through an approved secret-entry workflow. Never commit credentials or paste them into source files.

Once provisioned, bind the Hyperdrive configuration as `HYPERDRIVE` and implement the database adapter against `env.HYPERDRIVE.connectionString`. The current Node database layer uses process-global configuration and Node filesystem schema loading; it must be refactored and integration-tested before enabling API routes.

## Deployment guardrails

Deploy only this Worker from this branch. Do not change the Vercel project, production branch, production secrets, or existing Worker scripts. Do not enable payment verification/settlement, scheduled agents, cron execution, or writes to production data.
