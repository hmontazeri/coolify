# Zero-downtime deployment patch

This branch is Coolify **v3.12.36** (the exact commit the production image was
built from) plus a **rolling / zero-downtime deployment** patch for standalone
applications, and the fixes needed so status, stop, restart, logs and usage keep
working with the renamed container.

Base: tag [`v3.12.36`](https://github.com/coollabsio/coolify/releases/tag/v3.12.36) (`1c8c567`).

## Why

Stock v3 deploys every application with a hard stop-first swap:

```sh
docker stop -t 0 <appId> && docker rm --force <appId>   # old container gone
docker compose up -d                                    # new container starts only now
```

So there is a window with no container behind the Traefik service. This branch
starts the replacement container first and only removes the old one once the new
one answers HTTP.

## What changed

1. `apps/api/src/jobs/deployApplication.ts`
   - Starts the replacement container under a unique name `<applicationId>-<buildId>`
     while the current container keeps serving.
   - Waits until it answers HTTP on its port (falls back to "container is running
     and not restarting" after 20s for non-HTTP services).
   - Writes `/app/db/zd-active.json` (persistent volume) marking it active.
   - Waits 7s (the Traefik HTTP provider polls every 5s) and only then stops and
     removes the previous container, with a 15s stop grace period.
   - Applications with a published host port and PR previews cannot overlap and
     keep the legacy stop-first path.

2. `apps/api/src/routes/webhooks/traefik/handlers.ts`
   - The Traefik service points at the container named in `zd-active.json`
     (falling back to `<applicationId>`), so traffic switches to the replacement
     as soon as it is ready.
   - Adds the `coolify-retry` middleware (60 attempts, 500ms, live in production
     since 2026-05-19) as a backstop.

3. `apps/api/src/lib/docker.ts`
   - `checkContainer` resolves a renamed container through the
     `coolify.applicationId` label when `docker inspect <applicationId>` fails,
     and returns the resolved `name`.
   - New `resolveContainerName` helper (exact name, else by label).

4. `apps/api/src/routes/api/v1/applications/handlers.ts`
   - Status, stop, restart, logs, usage and image lookups resolve the current
     container name instead of assuming `<applicationId>`.

## Build

The Docker image is built from source with esbuild:

```sh
cd apps/api && pnpm install && pnpm build
```

## Notes

- Only standalone (non-compose) applications use the rolling path; Compose
  applications and one-click Services are unchanged.
- The Traefik config switch depends on the HTTP provider poll interval (5s).
