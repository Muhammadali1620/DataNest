# DataNest

[![CI](https://github.com/Muhammadali1620/DataNest/actions/workflows/ci.yml/badge.svg)](https://github.com/Muhammadali1620/DataNest/actions/workflows/ci.yml)

A free and open-source database client for VS Code and its forks (VSCodium, Cursor, Windsurf).

> **Status:** early development, not published yet. See [ROADMAP.md](ROADMAP.md).

## Principles

- Free forever: no premium features, no accounts, no connection limits, no telemetry.
- Works everywhere: no native modules, only the stable VS Code API.
- Fast and stable first, more features second.

## Development

Requirements: Node.js 22+, npm, Docker (for integration tests).

```sh
npm install
npm run build      # build the extension
npm test           # run unit tests
```

Press `F5` in VS Code to launch the Extension Development Host.

Architecture and contribution rules: [ARCHITECTURE.md](ARCHITECTURE.md).

## License

[MIT](LICENSE)
