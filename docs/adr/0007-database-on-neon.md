# ADR 0007: The database moves from Railway PostgreSQL to the Neon Free plan

- Status: accepted
- Date: 2026-11-15

## Context

The owner wants lower monthly costs for the projects on the Railway Hobby plan. The Hobby plan costs at least $5 a month and includes $5 of usage. Railway charges $10 per GB-month of memory. In the week before 2026-11-15, the service `Postgres caltodo` cost about $0.65 a month, mostly for memory. The six application services and the three databases of the Railway project together used about $8.7 a month.

The database is small: 8 MB on 2026-11-15, with two users. The database work comes from a few user sessions a day and from two jobs (00:00 and 01:15). On 2026-11-15 the owner moved the database of mastofeed to Neon in a pilot, and the pilot release passed its checks.

Neon offers serverless PostgreSQL. On the Free plan, the compute suspends after 5 minutes without queries. The plan gives 100 CU-hours a month at a minimum compute size of 0.25 CU, 1 GB of storage, and a history window of 6 hours. The owner created the Neon project `caltodo` (PostgreSQL 18, `aws-eu-central-1`).

Unlike the mastofeed data, the caltodo data is not regenerable. It holds the users, their encrypted OAuth tokens, their settings, and their action links.

## Decision

1. The service uses the Neon project `caltodo` as its database. The service stays on Railway.
2. The service connects to the direct Neon endpoint with `sslmode=verify-full`. It does not use the Neon pooler.
3. The pool opens no connection by itself (SQLx default `min_connections` 0). An idle connection in the pool does not keep the compute active: the compute suspends after 5 minutes without queries (`STACK.md` §5 Compute time).
4. A fresh copy (`pg_dump` and `pg_restore`, `STACK.md` §15 Data move) moves the data right before the switch of `DATABASE_URL`, outside the job times. The row counts of every table must match. After Railway removes the previous deployment, the content checksums of the Railway tables must equal the checksums of the copy, so no write between the copy and the switch is lost.
5. The Railway service `Postgres caltodo` stays unchanged as the rollback database. The owner decides when to remove it. Update of 2026-11-15: the owner removed the service and its volume on the day of the switch, after the release checks.

## Alternatives

- **Stay on Railway PostgreSQL.** No new provider and no extra latency. It keeps the cost of about $0.65 a month.
- **Neon pooler endpoint.** Rejected: the SQLx migrator holds a session advisory lock, which PgBouncer in transaction mode does not keep.
- **Neon Import Data Assistant.** Not used: its documented source versions are PostgreSQL 14 to 17, and the source runs 18.
- **An empty Neon database and new sign-ins.** Rejected: users would lose their settings and their action links.

## Consequences

- Neon becomes a new recipient of the account data: Google ids, email addresses, display names, encrypted OAuth tokens, settings, action link hashes, and sessions (`VISION.md`). Neon receives no OAuth token in plain text: the key `TOKEN_ENCRYPTION_KEY` stays in Railway.
- Database traffic goes over the public internet from `europe-west4` to Frankfurt, with TLS and a certificate check. Each query has more latency than on the Railway private network. The first request after a suspension waits for the compute to start. The Google calls of a task request take more time than this.
- When the project uses all CU-hours of a month, Neon suspends the compute until the next month, and sign-in, the task list, and the jobs fail. The estimate is below 15 CU-hours a month (`STACK.md` §5).
- The Neon history window of 6 hours adds a short restore path that Railway Hobby did not have.
- Railway removes the cost of `Postgres caltodo` only after the owner removes that service (done on 2026-11-15). The saving on the Railway bill is at most about $0.65 a month, and less when the usage falls below the $5 included in the Hobby plan.

## Cost of reversal

Medium. The owner removed the Railway database on 2026-11-15. A reversal is a data move to a new database (`STACK.md` §15 Data move), then a change of `DATABASE_URL`. No code change is necessary.

## Reassessment condition

Reassess when the Neon project uses more than 50 CU-hours in a month, when storage passes 800 MB, when the Neon Free plan terms change, or when cold starts cause failed requests.
