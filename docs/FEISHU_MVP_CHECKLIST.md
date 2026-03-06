# Feishu CN MVP Checklist (`/add-feishu`)

Implementation checklist for adding a **minimal Feishu CN channel** in NanoClaw, following the original NanoClaw development mode:
- skill-first
- minimal core changes
- test-backed
- explicit non-goals

## Scope Guardrails

### In Scope
- Feishu CN only
- WebSocket long-connection mode only
- Text in/out (DM + group)
- Parallel operation with existing channels
- Basic mention-to-trigger normalization for group messages

### Out of Scope
- Lark global support
- Webhook mode
- Cards, media, reactions, threads/topic routing
- Multi-account
- Advanced dedupe/replay/quota tuning

## Milestone Checklist

## M1 — Skill skeleton + package wiring
- [ ] Create `.pi/skills/add-feishu/`
- [ ] Add `manifest.yaml`
- [ ] Add `SKILL.md` with Feishu CN setup instructions
- [ ] Add modify intent note for `src/channels/index.ts`

**Exit criteria**
- [ ] Skill manifest validates and can be applied by `scripts/apply-skill.ts`

---

## M2 — Channel implementation (minimal)
- [ ] Add `src/channels/feishu.ts` (via skill `add/`)
- [ ] Implement `connect()` with Feishu WS client
- [ ] Register inbound `im.message.receive_v1`
- [ ] Parse text payload and map to NanoClaw `NewMessage`
- [ ] Implement `sendMessage()` using Feishu API text send
- [ ] Implement `disconnect()`, `isConnected()`, `ownsJid()`

**Exit criteria**
- [ ] `FEISHU_APP_ID` + `FEISHU_APP_SECRET` missing => channel factory returns `null`
- [ ] With creds, channel connects and handles inbound callback path

---

## M3 — Trigger and routing parity
- [ ] Group mention normalization -> prepend `@ASSISTANT_NAME` when needed
- [ ] Unregistered chats are ignored
- [ ] `onChatMetadata(...)` emitted for discovery

**Exit criteria**
- [ ] Mentioned group message can trigger flow similarly to Telegram

---

## M4 — Test coverage
- [ ] Add `src/channels/feishu.test.ts` (via skill `add/`)
- [ ] Factory behavior tests (creds/no creds)
- [ ] JID ownership tests (`fs:`)
- [ ] Inbound mapping tests
- [ ] Unregistered chat ignore tests
- [ ] Mention normalization tests
- [ ] Outbound send tests
- [ ] connect/disconnect lifecycle tests

**Exit criteria**
- [ ] `npx vitest run src/channels/feishu.test.ts` passes

---

## M5 — Apply and integrate in working tree
- [ ] Apply skill locally for integration testing
- [ ] Build and run full test suite
- [ ] Perform live smoke test with Feishu CN bot

**Exit criteria**
- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Live DM and group message receive/reply confirmed

---

## Runtime/Setup Checklist (Feishu CN)

- [ ] Create app in Feishu Open Platform (`open.feishu.cn`)
- [ ] Enable bot capability
- [ ] Enable event subscription (long connection)
- [ ] Add event: `im.message.receive_v1`
- [ ] Put credentials in `.env` and sync to `data/env/env`
- [ ] Rebuild and restart service
- [ ] Register chat using `fs:<chat_id>` format

## Commit Bucket Plan (recommended)

1. **docs(plan):** `docs/SPEC.md` + `docs/FEISHU_MVP_CHECKLIST.md`
2. **feat(skill):** `.pi/skills/add-feishu/**`
3. **feat(channel):** applied core changes (`src/channels/feishu.ts`, tests, index import, deps)
4. **docs(setup):** README / setup skill docs updates if needed

## Risks to watch

1. Feishu event shape differences across chat types
2. Mention detection edge cases in groups
3. Reconnect behavior of WS client under transient network failure

Mitigation: keep MVP text-only, assert behavior with unit tests + one live smoke test.
