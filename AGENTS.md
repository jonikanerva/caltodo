# Todo - Agent Guide

This repository contains Todo, a web-based todo app that stores tasks in Google Calendar and auto-schedules them into free time slots. Use the documents below for fuller details.

- [DOCTRINE.md](DOCTRINE.md), [VISION.md](VISION.md), and [STACK.md](STACK.md) — the quality doctrine, the product intent, and the stack with its commands and evidence rules. Read them before delivery work. `CLAUDE.md` is the contract for Claude Code.
- [README.md](README.md) — project overview, features, architecture, and local setup instructions.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, commit expectations, and UI/UX design guidelines.
- [docs/adr/](docs/adr/) — the architecture decisions.

Quick start:

- Install tools and dependencies: `mise trust`, then `mise run setup`
- Create `.env` with the Google OAuth secrets (see `README.md`)
- Develop: `mise run dev`
- Local databases: use only the `mise run db:*` tasks and the test tasks. They give each checkout its own development database and each test run its own temporary PostgreSQL container. Do not start, stop, prune, or delete database containers or volumes with your own `container` or `docker` commands. The `container` CLI fails inside a command sandbox; run the database and test tasks outside it.
- Run complete local validation: `mise run verify`
- Runtime model: a single web process (`caltodo serve`) handles the API, the action pages, the web app, and the scheduled jobs in-process (no separate worker process)
- Migrations are an explicit start step: `caltodo migrate` runs before `caltodo serve`
- Before committing, verify changes with `mise run verify`
- Before presenting results to the user, always run `mise run verify`
- Keep commits focused: one holistic change per commit; split unrelated or separate fixes into individual commits
