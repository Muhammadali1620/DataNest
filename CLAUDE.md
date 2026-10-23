# Project notes for Claude

Free, open-source database client extension for VS Code and its forks (VSCodium, Cursor, Windsurf).
The owner communicates in Russian; project docs are in Russian, code and identifiers in English.

Before any work, read:
- `ROADMAP.md` — versions and steps. Work step by step, mark statuses (`[ ]` → `[~]` → `[x]`), update the plan when it changes.
- `ARCHITECTURE.md` — stack, layers, folder layout, code style, decision log. Follow it; record new decisions in the decision log.

Hard rules:
- Clean-room: never copy code, texts, icons or branding from other database extensions (including cweijan's Database Client). Reimplement ideas only.
- No native Node modules; stable VS Code API only.
- `core/`, `drivers/`, `services/` must not import `vscode`.
- Passwords only in SecretStorage; user values in SQL only via parameters or `Dialect`.
- Every feature ships with thorough tests in the same step (happy path, edge cases, errors). All tests live only under `test/` (layout and rules: ARCHITECTURE.md §11), never next to source files.
