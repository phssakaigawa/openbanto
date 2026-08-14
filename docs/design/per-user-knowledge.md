# Per-user knowledge scoping

Status: **implemented** (`feat/per-user-knowledge`).

Knowledge (who the speaker is, their preferences, their projects) used to live in
a **single shared set** of files — `~/.openbanto/knowledge/{user-profile,preferences,projects}.md`
— read once, globally, regardless of who was speaking. That meant:

- The first-contact **ご記帳 (guest register) greeting** was decided from one global
  `user-profile.md` (`isNew = length < 50`). Once anyone was recorded, no new
  speaker was ever greeted; before that, everyone was greeted.
- One person's profile/preferences bled into every other speaker's context.

This change scopes knowledge **per speaker** while keeping an organization-wide
shared area and full backward compatibility with the old single-file layout.

## Directory layout

```
~/.openbanto/knowledge/
├── shared/                     # organization-wide notes (all speakers see these)
│   └── projects.md
├── users/
│   └── <userKey>/
│       ├── profile.md          # this speaker's identity / business info
│       └── preferences.md      # this speaker's style / language preferences
├── user-profile.md             # LEGACY single-user layout — still read (see below)
├── preferences.md              # LEGACY — still read as shared
└── projects.md                 # LEGACY — still read as shared
```

## `userKey(scope)`

`sessions/context.ts` derives a filesystem-safe key for the speaker:

- Prefers `speakerSlackId` (stable, unique — e.g. `U12345` → `u12345`).
- Falls back to a normalized `speakerName`.
- Lowercased; everything outside `[a-z0-9_-]` collapses to `-`; leading/trailing
  dashes trimmed; an empty result becomes **`unknown`** (never an empty path segment).

`ProjectContext` already carries `speakerSlackId` / `speakerName` (populated from
Slack `users.info` etc.), so `buildContext` just forwards them to the knowledge
builders — no new plumbing at the call sites.

## Per-user `isNew` (ご記帳 fires per speaker)

`buildEvolutionContext` now reads **this speaker's** `users/<userKey>/profile.md`
and computes `isNew = profileContent.length < 50`. So:

- A brand-new speaker gets the ONBOARDING (ご記帳) greeting.
- A speaker with a populated profile skips straight to steady-state help — even on
  their first message of a new session.

## Backward compatibility (non-destructive)

- Legacy top-level `knowledge/*.md` files are **never deleted or moved**. They are
  still listed in the knowledge base and read as **shared** content.
- If the scoped `users/<userKey>/profile.md` is empty/missing but a populated
  legacy `user-profile.md` exists, the **operator** (or an unnamed speaker) is
  treated as *known* — so the existing operator is not re-onboarded after the
  layout change. A named non-operator speaker with no scoped profile is still new.

## Recording is engine-agnostic

The steady-state / onboarding instructions tell the engine to record to the
speaker's own paths using **whatever file access it has**:

- OpenAI (AiDEA/Kannon) engine → the built-in **knowledge MCP tools**
  (`write_knowledge` / `read_knowledge`, paths relative to the knowledge root,
  e.g. `users/<userKey>/profile.md`). It has no native filesystem access.
- `claude` engine → native Read/Write to the absolute path, or the same MCP tools.

Both reach the same files. See `docs/design/tools-mcp-wiring.md` for the knowledge
MCP server (scoping, traversal defense, default-on wiring).

## Tests

- `sessions/__tests__/user-key.test.ts` — `userKey` normalization / fallback.
- `sessions/__tests__/per-user-knowledge.test.ts` — per-user `isNew` (one speaker
  new, another known) + listing isolation.
- `mcp/__tests__/knowledge-server.test.ts` — traversal defense + IO round-trip.
- `mcp/__tests__/resolver.test.ts` — knowledge server present by default / omitted
  when disabled.

## Identity propagation → automatic per-user scoping (番頭ID伝播)

Per-user knowledge no longer depends only on the system-prompt paths. The banto
now propagates the speaker's identity to the knowledge 職人 (and every other MCP
server) **every turn**, and the knowledge server auto-scopes on it:

- `mcp/resolver.ts` injects `JINN_USER_KEY` (plus `JINN_USER_ID` / `JINN_USER_NAME`
  / `JINN_CONNECTOR` / `JINN_CHANNEL`) into the knowledge server's stdio `env`.
  `sessions/manager.ts` derives `userKey` the same way `context.ts` does
  (SlackID-preferred → normalized name).
- With `JINN_USER_KEY` set, `knowledge-server.ts` makes **`users/<key>/` the
  default root**: a caller path `profile.md` → `users/<key>/profile.md`,
  `preferences.md` → `users/<key>/preferences.md`. The engine no longer has to
  spell out the `users/<userKey>/` prefix — it just writes `profile.md` and lands
  in the right person's subtree.
- `shared/…` is the org-wide escape hatch (maps to `knowledge/shared/…`).
- Without `JINN_USER_KEY` (cron / older callers) behaviour is the legacy
  knowledge-root-relative model — backward compatible.
- **Traversal defense is unchanged**: absolute / `..` / `~` / root-escaping
  symlinks are still rejected, and a scoped user still cannot escape
  `KNOWLEDGE_ROOT`. The rewrite happens *before* `resolveWithinRoot`.

The tool descriptions now state "your I/O is automatically scoped to the current
user", so per-user correctness holds even if the engine forgets the path
convention. See `docs/design/shokunin-contract.md` for the identity contract that
extends this to all 職人 (calendar, ledger, minutes, …), not just knowledge.
