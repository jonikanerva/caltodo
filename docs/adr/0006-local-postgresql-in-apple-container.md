# ADR 0006: Local PostgreSQL in Apple container

- Status: accepted; ADR 0007 replaces `scripts/caltodo-pg` with the shared `scripts/db.sh`
- Date: 2026-11-15

## Context

The local development database and the test databases ran on one Docker container (`caltodo-pg`, port 55473) for every checkout. Agents work in many worktrees at the same time. On the shared server:

- Two checkouts shared the development database `caltodo`.
- Two `test:e2e` runs used the same database `caltodo_e2e`, the same server port 47411, and the same Playwright output directory.
- Two `sqlx:check` runs in one checkout used the same database name, so one run could drop the database of the other.
- The test tasks took `DATABASE_URL` from the task environment. `mise run dev` took `DATABASE_URL` from `.env`, which pointed at a removed Homebrew server.

The owner works on an Apple silicon Mac and wants one container tool, without Docker, Colima, or OrbStack, and no PostgreSQL server on the Mac.

## Decision

1. Apple `container` (1.0.0) runs the local PostgreSQL servers. Each container is a light virtual machine.
2. `scripts/caltodo-pg` is the only owner of the container lifecycle. The mise tasks call it. It is a Bash 3.2 script without other dependencies than the macOS base tools (`shlock`, `nc`, `shasum`) and the Python 3 of the Xcode Command Line Tools for JSON.
3. The physical checkout path identifies a checkout (12 hexadecimal digits of its SHA-256). Each checkout has one development container and one named volume. The volume name contains the PostgreSQL major version. The development server keeps fsync on.
4. Each independent test run starts its own temporary container: the cluster on tmpfs, fsync off. The run exports `CALTODO_PG_RUN_*`; a nested task reuses the container only through these variables. `verify` and `test` use one container for their steps.
5. Labels on each test container name the checkout, the run, and the process id of the run. A new run deletes the containers of this checkout whose run process ended. `db:reap -- --all` does this for every checkout. No task runs a general prune.
6. A port conflict fails the container start, and the script tries another port. Ports listen on `127.0.0.1` only.
7. `test:e2e` gives each run its own client build, database, server port, and Playwright output directory under `target/e2e/<run>`. `build` and the SQLx prepare step write shared files of a checkout, so a checkout lock (`scripts/checkout-lock`) runs one of each at a time.
8. `dev` ignores `DATABASE_URL`; only `CALTODO_DEV_DATABASE_URL` selects another database.

## Alternatives

- **Docker through OrbStack (the old setup) with one database per run:** faster to start a server (one shared server), but it keeps a second container tool, and the isolation depends on unique names in a shared server.
- **One shared Apple container with databases per run:** fewer virtual machines, but one run can still drop or block the databases of another, and a stuck run blocks the server.
- **A PostgreSQL server on the Mac (Homebrew, Postgres.app, or the mise conda package):** no virtual machine, but it puts a server and its versions on the Mac, which the owner does not want.
- **A volume for each test container:** the data stays on disk until the delete. tmpfs is faster and leaves nothing behind.

## Consequences

- A test run starts a virtual machine and initializes a cluster: about 4 to 5 seconds before the first test (measurements below).
- Each test container takes memory of the Mac (2 GiB limit; about 150 MiB idle). `CALTODO_PG_MAX_TEST_RUNS` (default 4) limits the live test containers on the Mac.
- The `container` CLI uses XPC to its system service. A command sandbox blocks it, so agents run the database and test tasks outside the sandbox.
- A run that ends with SIGKILL leaves its container until the next run of the checkout or `db:reap`.
- Development data moves between checkouts only on request (`db:clone`, `db:dump`, `db:restore`). Tests start from an empty server and the migrations.
- A PostgreSQL major version change gives every checkout a new development volume. The old volume stays.

## Cost of reversal

Low. The mise task names stay. A return to Docker changes `scripts/caltodo-pg` and the documents; the test code does not depend on the container tool.

## Reassessment

Reassess when Apple `container` changes its CLI or JSON output in a way that breaks the script, when the owner moves away from macOS, or when the start time of a test container becomes a large part of the test time.

## Measurements (2026-11-15)

Apple silicon Mac, Apple `container` 1.0.0, image `postgres:18` (18.7). Other agents built and tested other projects on the same Mac at the same time, so the times vary.

| Step                                                      | Result                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| Image pull of all platforms (the `container run` default) | 216 s; the script pulls `linux/arm64` only                    |
| Test container: start to a PostgreSQL answer              | 4 to 5 s (2.7 s for `container run`)                          |
| Test container: delete                                    | 0.5 s                                                         |
| Development container: first start with a new volume      | 6 s on a quiet Mac, 27 s under load                           |
| Development container: stop, start                        | 0.5 s and 1.3 s on a quiet Mac; 3.9 s and 6.2 s under load    |
| `db:start` when the container runs                        | 1.4 s                                                         |
| Nextest (198 tests), with the start and the delete        | tmpfs 14 to 15 s; container disk 17 s; Docker (OrbStack) 18 s |
| Memory                                                    | test container about 150 MiB idle; development 90 MiB         |

`server_answers` in the script exists because the port forwarder of `container` accepts a TCP connection before the server is reachable. A plain TCP check passed too early.
