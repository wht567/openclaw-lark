# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # Build ESM output to dist/ (tsdown)
pnpm test           # Run all vitest tests
pnpm test:watch     # Run tests in watch mode
pnpm lint           # ESLint on src/ and index.ts
pnpm lint:fix       # ESLint auto-fix
pnpm typecheck      # TypeScript --noEmit
pnpm format:check   # Prettier check (CI uses this)
pnpm format         # Prettier write
```

- Node >= 22, pnpm@10 (packageManager specified in package.json)
- Build with `tsdown` — config at `tsdown.config.ts`. Bundles ESM for Node 22, externalizes `openclaw`, `@larksuiteoapi/*`, `zod`, `@sinclair/typebox`, `image-size`, `node:*`.
- Tests use `vitest`, config at `vitest.config.ts`. Run a single test: `pnpm test -- -t "test name pattern"`.

## Architecture

This is an **OpenClaw channel plugin** (`@larksuite/openclaw-lark`) that connects OpenClaw AI agents to the Lark/Feishu workspace. It runs inside the OpenClaw platform as a plugin (not a standalone service).

### Entry point and registration flow

`index.ts` is the plugin entry. On `register(api)`:
1. Sets the `PluginRuntime` singleton on `LarkClient`
2. Registers the `feishuPlugin` as a channel (`api.registerChannel`)
3. Registers tool families: OAPI tools (calendar, task, bitable, drive, wiki, sheets, IM, chat, search), MCP doc tools, OAuth tools, AskUserQuestion tool
4. Hooks `before_tool_call` / `after_tool_call` for logging and tool-use trace tracking
5. Registers CLI commands (`feishu-diagnose`, `/feishu_doctor`, `/feishu_auth`, `/feishu_help`) and emits multi-account security warnings

### Top-level directory layout

| Directory | Purpose |
|---|---|
| `src/channel/` | Channel plugin implementation, WebSocket monitor, event handlers, chat queue, onboarding, directory |
| `src/core/` | LarkClient SDK wrapper, config schema (Zod), accounts, auth, token store, domain resolution, types |
| `src/messaging/inbound/` | Message parsing, dispatch, gating/permission, dedup, mention extraction, comment/reaction/VC handlers |
| `src/messaging/outbound/` | Send messages/cards/media, reactions, chat management, forward, typing indicators |
| `src/messaging/converters/` | Convert Feishu message types (text, image, file, audio, video, post, sticker, card, etc.) to OpenClaw format |
| `src/card/` | Streaming card controller, reply dispatcher, card builder, markdown styling, tool-use display |
| `src/tools/oapi/` | Tools wrapping Feishu Open API directly (calendar, task, bitable, drive, wiki, sheets, IM, chat, search) |
| `src/tools/mcp/` | Tools using Model Context Protocol (doc CRUD) |
| `src/tools/` | OAuth onboarding, auto-auth, batch auth, AskUserQuestion interactive tool |
| `src/commands/` | CLI diagnostic, doctor, auth, locale commands |
| `skills/` | AI agent skill definitions (Markdown files) for bitable, calendar, doc, IM, task, troubleshoot |

### Key architectural patterns

**ChannelPlugin contract** (`src/channel/plugin.ts`): The `feishuPlugin` object implements OpenClaw's `ChannelPlugin<LarkAccount>` interface — capabilities, pairing, gateway (start/stop account), messaging (target normalization), directory, outbound, threading, status/probe, config schema, groups/tool policy, and security warnings.

**LarkClient** (`src/core/lark-client.ts`): Singleton-style SDK wrapper cached per accountId. Manages `Lark.Client` (HTTP SDK), `Lark.WSClient` (WebSocket), bot identity (probed via `/bot/v1/openclaw_bot/ping`), message dedup lifecycle, and hot-reload credential change detection.

**Inbound pipeline**: `monitor.ts` creates one `LarkClient` per account, attaches event handlers, starts WebSocket. Events flow through `event-handlers.ts` → dedup/expiry check → `chat-queue.ts` serialization (one concurrent task per account+chat+thread) → `handleFeishuMessage()` → `dispatchToAgent()` in `dispatch.ts`. Dispatch routes to system commands, comment targets, or normal messages (streaming/static cards).

**Reply dispatcher** (`src/card/reply-dispatcher.ts`): Factory that creates a reply dispatcher with either streaming card mode (`StreamingCardController`) or static mode (text chunks via `sendMessageFeishu`). Handles typing indicators, footer config, markdown table mode, and card→text fallback on API errors.

**Multi-account config** (`src/core/accounts.ts`): Accounts live under `channels.feishu.accounts.<id>`. Each account overrides top-level Feishu config; unset fields fall back. The `DEFAULT_ACCOUNT_ID` is used when no explicit accounts exist. Most runtime helpers use `createAccountScopedConfig()` to get an account-resolved config view.

**Chat queue** (`src/channel/chat-queue.ts`): Process-level singleton — tasks targeting the same account+chat are serialized via a promise chain. Also tracks active dispatchers for the abort fast-path.

**Dedup** (`src/messaging/inbound/dedup.ts`): In-memory LRU-ish dedup with configurable TTL (default 12h) and max entries. Protects against WebSocket reconnect replay. Attached to `LarkClient.messageDedup`.

**Config schema** (`src/core/config-schema.ts`): Zod schemas with `.superRefine()` cross-field validation, auto-converted to JSON Schema (draft-07) for the OpenClaw plugin system. Supports per-group overrides (`groups.<chatId>`).

### Important conventions

- All new source files must include the copyright header: `Copyright (c) 2026 ByteDance Ltd. and/or its affiliates` with `SPDX-License-Identifier: MIT`
- Git commits require a `Signed-off-by` line (DCO)
- The plugin **depends on the OpenClaw platform** — `openclaw` is a peer dependency (never bundled). OpenClaw version must be >= 2026.2.26
- Feishu SDK (`@larksuiteoapi/node-sdk`) provides the HTTP client, WebSocket client, and event dispatching
- Logger is always accessed via `larkLogger(scope)` from `src/core/lark-logger.ts`
- Account-scoped config should be obtained via `getLarkAccount()` + `createAccountScopedConfig()` rather than reading `cfg.channels.feishu` directly
