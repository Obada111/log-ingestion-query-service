# 05. Docker

## Summary

The service runs as two containers defined in `docker-compose.yml`: `db` (postgres:16-alpine, 1 CPU / 1 GB, tuned via `-c` flags) and `app` (built from a multi-stage Dockerfile, Node 22 alpine, non-root, 0.5 CPU / 256 MB). Compose wires them together with a `pg_isready` healthcheck, `depends_on: condition: service_healthy`, a named `pgdata` volume for persistence, and port 5432 exposed so integration tests can reach the database from the host. The Dockerfile is deliberately multi-stage so the 256 MB runtime image ships only compiled JS and production dependencies — no TypeScript sources, no dev tooling.

## Detailed explanation

### The Dockerfile (multi-stage)

The build has three stages (`Dockerfile:5-27`):

1. **`deps`** — `FROM node:22-alpine`, copies only `package.json` + `package-lock.json`, runs `npm ci`. Alpine is used for image size (musl libc, ~50 MB base) and Node 22 matches the `engines` requirement (`package.json:8`). Running `npm ci` on just the lockfile pair maximizes layer caching — dependency layers only rebuild when the lockfile changes.
2. **`build`** — copies the `deps` node_modules (no reinstall), adds `tsconfig.json` + `src/`, runs `npm run build` (`tsc`) to emit `dist/`.
3. **`runtime`** — the image that actually runs. `NODE_ENV=production`, fresh `npm ci --omit=dev` (only runtime deps: ajv, ajv-formats, fastify, pg), then copies `dist/` from the build stage. `USER node` drops root privileges, `EXPOSE 8080`, `CMD ["node", "dist/index.js"]`.

Why `npm ci` twice: `npm ci` is reproducible (respects the lockfile exactly, deletes `node_modules` first) unlike `npm install`, and the runtime reinstall with `--omit=dev` guarantees dev-only packages (typescript, eslint, tsx) never ship. The image must copy package files again in the runtime stage because the `deps`/`build` stages were intermediate layers; only explicitly copied artifacts (dist + fresh prod node_modules) land in the final image.

The `.dockerignore` (`.dockerignore:1-8`) excludes `node_modules`, `dist`, `.git`, `tests`, `loadtest`, `scripts`, `*.md`, and `.env` from the build context — keeping context small and preventing host `node_modules` (Windows-built) from leaking into the Linux image.

### docker-compose.yml

`db` (`docker-compose.yml:5-45`): `postgres:16-alpine`, credentials via `POSTGRES_USER/PASSWORD/DB` env, PostgreSQL tuning via `command:` flags — `shared_buffers=512MB`, `effective_cache_size=768MB`, `work_mem=16MB`, `maintenance_work_mem=128MB`, `max_connections=50`, `wal_buffers=16MB`, `checkpoint_completion_target=0.9`, `max_wal_size=2GB`, `min_wal_size=256MB`, `autovacuum_work_mem=64MB`, `timezone=UTC` (see study 14). A named volume `pgdata` mounts `/var/lib/postgresql/data` so data survives `docker compose down`. Port `5432:5432` is exposed to the host deliberately — integration tests and the smoke script talk to PG over `localhost:5432`. The healthcheck runs `pg_isready -U loguser -d logdb` every 2 s with a 3 s timeout and 30 retries.

`app` (`docker-compose.yml:47-66`): built from the current directory, gets `DATABASE_URL=postgres://loguser:logpass@db:5432/logdb` (service name `db` resolves inside the compose network), optional `AUTH_ENABLED`/`LOADGEN_API_KEY`/`RETENTION_HOURS` passthroughs, port `8080:8080`, and the crucial ordering rule `depends_on: db: condition: service_healthy` — the app container only starts after PG passes `pg_isready`. Resource caps are declared with `deploy.resources.limits` (`cpus: "0.5"`, `memory: 256m` for the app; `cpus: "1.0"`, `memory: 1g` for the DB) — these are the exact caps the performance contract was measured under. Both services use `restart: unless-stopped`.

The app still waits for the DB itself (`waitForDatabase` with retry/backoff, `src/db/pool.ts:58-69`) — belt and braces: `pg_isready` only proves the server accepts connections, not that migrations are done; readiness gating is `/health`'s job.

### Startup ordering (the full chain)

`docker compose up` → PG container starts → `pg_isready` healthcheck passes → app container starts → `waitForDatabase` → embedded migrations under advisory lock → (optional) key seed → retention sweeper → `listen()` → `/health` flips from 503 to 200. Only after that do clients see a ready service.

### Windows / Docker Desktop gotchas (real, hit during this project)

- **Use `npm.cmd`, not `npm`**: on Windows PowerShell, `npm` resolves to the .cmd shim only if you call it as `npm.cmd`; scripts in `package.json` like `test:integration` are invoked through Node, so inside `npm run ...` the shims work — the issue is direct shell usage (`npm.cmd run typecheck`).
- **Quote `node --test` globs**: `node --test "tests/unit/*.test.ts"` — unquoted globs are expanded by PowerShell/cmd before Node sees them and the pattern is lost; the quotes must be part of the npm script string (`package.json:16-17`).
- **Docker Desktop is a VM (WSL2/Hyper-V)**: the Linux containers run in a VM that shares the host's resources; the memory cap (`memory: 256m`) is *inside* the container, but Docker Desktop itself also consumes host RAM. Watch both the VM memory settings and the container metrics (`docker stats`) when reproducing the load test.
- **File sharing**: bind mounts through the Docker Desktop VM are slow; the project avoids them (no `./src:/app` volume, `.dockerignore` keeps context lean), which also keeps Windows line endings from entering the image.
- **Timer jitter**: Node timers inside containers on Docker Desktop have ~ms jitter; the load generator's pacing is computed from elapsed time precisely because of this (`loadtest/loadgen.mjs:156-160`), and the 10 ms flush timer tolerates it.
- **Ports on Windows**: `5432:5432` collides if a local PostgreSQL runs on the same port — change the left side (`"55432:5432"`) and set `TEST_DATABASE_URL` accordingly.

## Why this exists

The contract's resource caps (0.5 CPU / 256 MB app, 1 CPU / 1 GB DB) are meaningless unless the deployment enforces them, and "zero configuration" means the entire environment must come up from one command. Docker Compose provides: reproducible images (multi-stage + `npm ci`), enforced limits (`deploy.resources.limits`), deterministic startup (healthcheck-gated `depends_on`), persistent data (named volume), and a host-reachable PG port so the 39 integration tests run against the real database — the same artifacts the graders use.

## Alternatives considered

| Approach | Pros | Cons |
|---|---|---|
| Single-stage Dockerfile (`npm install` + source in image) | Simpler to read | Ships devDeps + TS sources into 256 MB; image build less reproducible |
| `node:22-slim` base | glibc, more compatible tooling | Larger (~120 MB); alpine's size advantage matters at 256 MB |
| Distroless (`gcr.io/distroless/nodejs`) | Minimal attack surface | No shell for debugging (`docker exec`), harder to troubleshoot; non-root `node` user already covers the main win |
| `npm install` instead of `npm ci` | Slightly faster on cache warm | Not lockfile-reproducible; can drift from `package-lock.json` |
| App talks to PG without `depends_on` + healthcheck | Shorter compose | Races on startup; the app's own backoff would mask DB-not-ready but wastes boot cycles |
| **Chosen: multi-stage alpine + compose with healthcheck gating + explicit limits** | Small runtime, reproducible, measured under the exact caps | Two images to reason about; alpine musl quirks if native deps ever appear |

## Why this was chosen

Every choice maps to a constraint: multi-stage because the runtime cap is 256 MB and TypeScript sources + devDeps would waste half of it; alpine because it is the smallest maintained Node base; `npm ci` because the lockfile is the source of truth and reproducibility matters when the grader rebuilds; non-root because the README's "defense in depth" is one line that costs nothing; the healthcheck-gated `depends_on` because the app's migrations must never race a booting PG; and explicit `deploy.resources.limits` because the performance contract (15k/s, p95 < 1 s) was measured *at* those limits — running without them would invalidate every number in the README. Port 5432 is exposed because the integration test suite (`tests/integration/*.test.ts`) connects to `localhost:5432` from the host.

## Advantages / Disadvantages / Trade-offs

### Advantages

- One command (`docker compose up`) reproduces the entire graded environment, resource caps included.
- Build layers are cache-friendly (lockfile-only first), so rebuilds are fast.
- `USER node` + no shell-ish deps and `--omit=dev` shrink attack surface and image size.
- Named volume makes the DB state survive restarts, which is why the smoke script can run repeatedly against accumulated data.

### Disadvantages

- Two environments to keep in sync (containerized vs host dev — Node on Windows vs Node 22 alpine/musl).
- `deploy.resources.limits` only applies with Docker Compose v2/swarm semantics; plain `docker run` needs `--cpus/--memory` flags instead.
- Alpine (musl) can bite if native npm modules are ever added (prebuilt binaries are usually glibc); today's deps (ajv, fastify, pg) are pure JS so it is a non-issue.

### Trade-offs

- Runtime stage reinstalls dependencies (`npm ci --omit=dev`) at build time to keep the image lean — extra build seconds in exchange for tens of MB saved.
- `pgdata` named volume vs bind mount: persistence wins; ad-hoc SQL inspection of the DB requires `docker compose exec db psql` instead of a shared folder.
- Exposing 5432 to the host is convenient for tests but widens the attack surface if the host network is untrusted — the trade the project accepted for testability.

## Code

The complete Dockerfile (`Dockerfile:5-27`):

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Run as non-root: defense in depth if the container is ever compromised.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

The healthcheck-gated dependency ordering and resource limits (`docker-compose.yml:35-66`):

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U loguser -d logdb"]
  interval: 2s
  timeout: 3s
  retries: 30
...
app:
  build: .
  depends_on:
    db:
      condition: service_healthy
  deploy:
    resources:
      limits:
        cpus: "0.5"
        memory: 256m
```

The DB's own startup retry, which makes the app robust even without compose ordering (`src/db/pool.ts:58-69`):

```ts
export async function waitForDatabase(pool: pg.Pool, attempts = 60): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      ...
      await new Promise((r) => setTimeout(r, Math.min(1000 * i, 5_000)));
    }
  }
}
```

## Diagrams

```mermaid
flowchart LR
    subgraph build["Build (Dockerfile)"]
        A["node:22-alpine deps<br/>npm ci (lockfile only)"] --> B["build stage<br/>tsc -> dist/"]
        B --> C["runtime stage<br/>npm ci --omit=dev<br/>USER node<br/>CMD node dist/index.js"]
    end
    subgraph runtime["Compose runtime"]
        DB[("db: postgres:16-alpine<br/>1 CPU / 1 GB<br/>-c shared_buffers=512MB<br/>pgdata volume<br/>5432 exposed")]
        APP["app: built image<br/>0.5 CPU / 256 MB<br/>8080 exposed"]
        DB -. "pg_isready healthcheck" .-> APP
        HOST["Host<br/>integration tests, smoke, loadgen"] -->|"localhost:5432"| DB
        HOST -->|"localhost:8080"| APP
    end
    C --> APP
```

## Common mistakes

- **`npm install` instead of `npm ci`**: installs can mutate the lockfile and pull different versions; `ci` is the reproducible choice in images (and CI).
- **Skipping `--omit=dev`**: ships typescript/eslint/tsx into a 256 MB container — the exact waste the multi-stage design exists to prevent.
- **Running as root**: the default; one `USER node` line removes a whole privilege-escalation class.
- **`depends_on` without `condition: service_healthy`**: `depends_on` alone only orders startup, it does not wait for readiness — PG would be mid-boot when the app's migrations fire.
- **Windows shell traps**: `npm` (not `npm.cmd`) in PowerShell, and unquoted test globs — both hit this project (see `package.json:16-17` for the quoted form).
- **Not measuring at the caps**: the README's numbers (15k/s, p95 aggregate 162 ms) were produced *with* `deploy.resources.limits` in place; a dev machine without caps will report much better numbers that then fail to reproduce.
- **Forgetting `.dockerignore`**: without it, the build context ships `node_modules`/`.git`/`tests` into the builder — slow uploads and a real risk of a Windows-built `node_modules` being copied over the Linux one.

## Optimization ideas

- `--mount=type=cache` for `npm ci` (BuildKit) to skip re-downloading the registry on every build.
- Pin base image digests (`node:22-alpine@sha256:...`) for fully reproducible builds.
- Add a `healthcheck` for the app itself (`node -e fetch('/health')`) so compose/K8s can gate traffic on real readiness.
- Merge to a single `node:22-alpine` stage with `npm prune --omit=dev` after build to halve build steps if build time matters more than purity.
- For production: `docker buildx build --platform linux/amd64` to avoid Apple-Silicon/ARM images running under emulation.

## Interview questions & answers

1. **Q: Why is the Dockerfile multi-stage?** A: The runtime container is capped at 256 MB; shipping TypeScript sources, devDependencies, and build tools would waste half of it. Stages let the runtime image carry only `dist/` + prod deps while the build stage does the compilation.
2. **Q: Why `npm ci` and not `npm install`?** A: `ci` installs exactly what the lockfile pins, never mutates it, and deletes stale `node_modules` first — deterministic builds. `install` can resolve differently or silently update the lockfile.
3. **Q: What does `depends_on: condition: service_healthy` actually guarantee?** A: The app container is not started until the DB's healthcheck (`pg_isready`) passes. Without `condition`, `depends_on` only orders container starts and the app would race PG's boot.
4. **Q: Why is port 5432 exposed to the host?** A: So the integration test suite and smoke script can connect to the real database from the host (`postgres://loguser:logpass@localhost:5432/logdb`) — tests run against the same PG the app uses, not a test double.
5. **Q: Why alpine?** A: Smallest maintained Node base image; with pure-JS deps (ajv, fastify, pg) musl compatibility is a non-issue. It would need re-evaluation only if native modules appear.
6. **Q: How do you enforce the 0.5 CPU / 256 MB cap?** A: `deploy.resources.limits` in compose; the same contract in Kubernetes is `resources.limits.cpu/memory`. The performance numbers were measured under these exact caps.
7. **Q: What happens to data when you run `docker compose down`?** A: Named volumes (`pgdata`) survive; data persists. `docker compose down -v` is the destructive form. That's why the smoke script needs unique service names per run — the DB volume accumulates rows.
8. **Q: Why does the app still poll the DB if compose already gates on `pg_isready`?** A: `pg_isready` proves the server accepts connections, not that it is ready to serve heavy traffic or that migrations are applied; the app's `waitForDatabase` with backoff (`src/db/pool.ts:58-69`) and the `/health` readiness gate cover the rest.
9. **Q: What Windows-specific issues did this project hit?** A: `npm` vs `npm.cmd` in PowerShell; `node --test` globs needing quotes (`"tests/unit/*.test.ts"`); Docker Desktop VM timer jitter (~ms) that made wall-clock pacing unreliable — the load generator computes pacing from elapsed time instead.
10. **Q: How would you shrink the image further?** A: Distroless base, `docker-slim`, or compiling to a single binary via `pkg`/bun — but at this size (alpine + prod deps) the marginal gains don't justify the debugging friction.

## Implementation references

- `../Dockerfile:5-27` — three-stage build (deps/build/runtime)
- `../docker-compose.yml:5-45` — db service, tuning flags, healthcheck, volume, ports
- `../docker-compose.yml:47-66` — app service, limits, `depends_on`
- `../.dockerignore:1-8` — build context exclusions
- `../src/db/pool.ts:58-69` — `waitForDatabase` retry with backoff
- `../src/index.ts:21-47` — startup chain after the container boots
- `../package.json:10-19` — scripts (incl. quoted test globs)
- `../.env.example:1-22` — every runtime knob with its default
- `../README.md:196-207` — Windows development commands (`npm.cmd run ...`)
