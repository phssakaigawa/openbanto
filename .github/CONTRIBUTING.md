# Contributing to OpenBanto

Thanks for your interest in contributing. This guide covers the basics.

> OpenBanto is a fork of [OpenRyoko](https://github.com/rsensui2/OpenRyoko)
> (itself based on [Jinn](https://github.com/hristo2612/jinn)). Contributions
> **specific to OpenBanto** — the IBM Bob engine, the 番頭 persona, the rebrand,
> etc. — belong here. Improvements to the **inherited platform / Slack
> behaviours** are often best sent upstream to OpenRyoko / Jinn. See
> `docs/upstream-port/` for how the layers relate.

## Prerequisites

- Node.js 22 or later
- pnpm 10+
- An engine CLI to actually run it. The default is **IBM Bob**
  (`curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash`, then set the
  `BOB_API_KEY` environment variable). Claude Code / Codex / Gemini also work by
  changing `engines.default`.

## Development Setup

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Initialize OpenBanto (one-time — builds all packages and creates `~/.openbanto`):
   ```bash
   pnpm setup
   ```
   This is safe to re-run; it skips files that already exist.
4. Start development mode:
   ```bash
   pnpm dev
   ```
   Then open [http://localhost:3000](http://localhost:3000). The Next.js dev
   server proxies API requests to the gateway on `:7777` automatically.

## Submitting Pull Requests

- Create a feature branch from `main`.
- Keep commits focused and descriptive.
- Run `pnpm typecheck` and `pnpm build` before submitting.
- Open a pull request against `main` with a clear description of your changes.
- If your change touches an area listed in
  `docs/upstream-port/BANTO-PORT-PLAN.md`, mention it so a later upstream merge
  doesn't regress it.

## Code Style

- TypeScript with strict mode enabled.
- ESM modules (no CommonJS).
- Tailwind CSS for styling in the web package.
- Follow existing patterns in the codebase.

## Project Layout

- `packages/jimmy` — core gateway daemon and CLI (published as `openbanto`).
- `packages/web` — web dashboard frontend (`@openbanto/web`).

## Questions?

Open an issue on GitHub if you have questions or run into problems.
