# CalTodo - Agent Guide

This repository contains CalTodo, a web-based todo app that stores tasks in Google Calendar and auto-schedules them into free time slots. Use the documents below for fuller details.

- [README.md](README.md) — project overview, features, architecture, and local setup instructions.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, commit expectations, and UI/UX design guidelines.

Quick start:

- Install dependencies: `npm install`
- Create `.env` with database and Google OAuth secrets (see `README.md`)
- Develop: `npm run dev`
- Before committing, verify changes with `npm run check` and `npm run build`
- Before presenting results to the user, always run `npm run check` and `npm run build`
- Keep commits focused: one holistic change per commit; split unrelated or separate fixes into individual commits
