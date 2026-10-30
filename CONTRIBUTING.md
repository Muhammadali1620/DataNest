# Contributing to DataNest

Thank you for helping. DataNest is a free, open-source database client; contributions of
every size are welcome — a bug report, a translation fix, a test, a driver.

## Reporting problems

Run **DataNest: Report a Problem…** in the editor — it opens the bug form with the DataNest,
editor and system versions filled in — or open an
[issue](https://github.com/Muhammadali1620/DataNest/issues/new/choose) yourself. Give the
database and its version, the steps, what you expected and what happened. **Show Logs** with `datanest.logLevel` set to `debug` usually tells the most;
read it through before attaching it.

## Working on the code

Requirements: Node.js 22+, npm, Docker for the integration tests.

```sh
npm install
npm run build             # build the extension
npm test                  # unit tests
npm run lint              # ESLint and Prettier
npm run typecheck         # TypeScript and svelte-check
npm run db:up             # start the core test databases (ports 7000–7999 on 127.0.0.1)
npm run test:integration  # integration tests of every running group
npm run test:e2e          # smoke tests in a real VS Code
npm run test:perf         # the performance budget
npm run db:down           # stop the test databases
```

Press `F5` in VS Code to start an Extension Development Host with your build.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before a larger change: the layers (`core`,
`drivers`, `services`, `vscode`, `webview`) and what each may import, the code style and the
decision log. The plan is in [ROADMAP.md](ROADMAP.md). (Both are written in Russian; the code,
comments and these guides are in English.)

## Rules

- **Clean-room**: never copy code, texts, icons or branding from other database
  extensions. Reimplement ideas only.
- **No native modules** and only the stable VS Code API.
- **Tests with every change**, in the same pull request, and only under `test/`: the usual
  case, the edge cases and the errors.
- **Passwords** only in SecretStorage; values in SQL only through parameters or the
  dialect's quoting.
- Interface texts go through `vscode.l10n.t()`, the webview dictionaries or `msg()`, with a
  Russian translation.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

To add a database, follow [Adding a database driver](docs/contributing/adding-a-driver.md).
