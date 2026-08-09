# Changelog — OpenBanto

OpenBanto is a fork of [OpenRyoko](https://github.com/rsensui2/OpenRyoko) (MIT),
which is itself based on [Jinn](https://github.com/hristo2612/jinn) (MIT). This
file tracks **OpenBanto's own changes on top of upstream**. For the history of
the inherited platform (daemon, AI org, cron, dashboard, MCP) and the Slack
behaviours (triage, `/goal`, Agents View canvas, …), see the OpenRyoko and Jinn
repositories — that work is not reproduced here.

## [Unreleased] — fork from OpenRyoko

### Added
- **IBM Bob engine (default).** `bob run` implemented as a first-class engine:
  a one-shot path plus an interruptible session engine with conversation resume
  via `task_id`. The model is bound to the Bob team / API key; auth via the
  `BOB_API_KEY` environment variable.
- **WhatsApp connector made an optional plugin.** `@whiskeysockets/baileys`
  (GPL-3.0) moved out of the core dependencies to an **optional peer dependency**
  and is loaded via dynamic import, so the core distribution builds and stays
  MIT-clean without it. Install it yourself (`npm i @whiskeysockets/baileys`) to
  enable WhatsApp.
- **番頭 (steward) persona + "ご記帳" onboarding.** The default identity is a
  front-of-house 番頭 that greets warmly, invites first-time guests to "sign the
  guest register" (ご記帳), then delegates heavy work to the engine.

### Changed
- **Default engine is now IBM Bob** (was Claude Code). Claude Code / Codex /
  Gemini remain selectable via `engines.default`.
- **Rebrand** OpenRyoko/Ryoko → OpenBanto/Banto. The home directory `~/.ryoko`
  (and legacy `~/.jinn`) auto-migrates to `~/.openbanto`; the internal
  `JINN_HOME` constant name is kept for backwards compatibility.
- README reoriented around IBM Bob as the default engine; Claude Code is
  presented as a switchable engine.

### Attribution
- Upstream MIT license/copyright retained in `LICENSE`; see `NOTICE` for the
  Jinn → OpenRyoko → OpenBanto chain. "IBM" / "Bob" are trademarks of IBM;
  OpenBanto is not affiliated with or endorsed by IBM.
