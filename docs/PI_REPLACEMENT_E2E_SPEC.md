# Pi Runtime Replacement E2E Specification

## Purpose

Define end-to-end validation for the NanoClaw fork that fully replaces Claude Code / Claude Agent SDK execution with the Pi Coding Agent runtime.

This spec is the acceptance contract for migration completion.

---

## Migration Success Criteria

Implementation is considered successful only if **all** of the following are true:

1. **Runtime replacement complete**
   - No container-side runtime dependency on Claude Agent SDK or Claude Code CLI.
   - Container agent runner uses Pi SDK/runtime for agent execution.
2. **Behavioral parity for core workflows**
   - Inbound message to outbound response works for registered groups.
   - Multi-turn continuity is preserved via persisted sessions.
   - Scheduled tasks run and can message back.
   - IPC-backed control tools remain functional.
3. **Security/authorization invariants preserved**
   - Main vs non-main privileges remain enforced.
   - Group isolation boundaries remain intact.
4. **Operational integrity preserved**
   - Queueing, retries, cursor recovery, and concurrency limits continue to work.

---

## Test Matrix

### E2E-00: Static Replacement Audit (Hard Gate)

**Goal:** Prove Claude runtime path is removed.

**Checks:**
- `container/agent-runner/package.json` does not include `@anthropic-ai/claude-agent-sdk`.
- `container/Dockerfile` does not install `@anthropic-ai/claude-code`.
- Agent runner source no longer imports Claude Agent SDK modules.
- Build succeeds with Pi runtime dependencies only.

**Pass/Fail:** Any remaining Claude runtime dependency/import fails this gate.

---

### E2E-01: Pi Runner Boot & Protocol Compatibility

**Goal:** Ensure the container runner boots with Pi and speaks NanoClaw output protocol.

**Setup:**
- Build container image.
- Invoke agent runner stdin with minimal `ContainerInput` payload.

**Assertions:**
- Runner process starts and exits cleanly.
- Emits marker-wrapped output blocks (`OUTPUT_START/END`) parseable by host.
- Emits `newSessionId` (or session identifier) for persistence.

---

### E2E-02: Basic Message Roundtrip

**Goal:** Validate primary user path.

**Setup:**
- Use test channel/fake channel with one registered group.
- Insert inbound triggered message.

**Assertions:**
- Message loop picks message from DB.
- Pi container agent is invoked.
- Outbound message sent through owning channel.
- Router cursors advance (`last_timestamp`, `last_agent_timestamp`).

---

### E2E-03: Streaming / Incremental Output Compatibility

**Goal:** Preserve incremental delivery behavior expected by host queue/router.

**Setup:**
- Prompt designed to produce >1 assistant output update.

**Assertions:**
- Host receives >1 marker output callback, OR (if design changed) receives equivalent bounded incremental events documented and tested.
- Output ordering is preserved.
- Completion marker/status emitted.

**Note:** If migration intentionally changes chunking granularity, this test must be updated with the new documented contract.

---

### E2E-04: Active Session Follow-Up Input

**Goal:** Validate follow-up message behavior while a container session is active.

**Setup:**
- Trigger first long-running prompt.
- Inject second message before first finishes.

**Assertions:**
- Second message is not lost.
- It is processed in-order without duplicate replies.
- Container close sentinel still terminates loop gracefully.

---

### E2E-05: Session Continuity Across Restart

**Goal:** Ensure state persistence remains intact with Pi sessions.

**Setup:**
- Send initial prompt in group.
- Restart host process.
- Send follow-up referencing prior context.

**Assertions:**
- Session resumes prior context.
- `sessions` table contains persisted Pi session identifier/path per group.
- Continuity survives process restart.

---

### E2E-06: Scheduled Task End-to-End

**Goal:** Validate scheduler parity with Pi runtime.

**Setup:**
- Create a near-term task (`once` or short interval) using in-agent tooling.

**Assertions:**
- Task row created in `scheduled_tasks`.
- Scheduler executes due task in container via Pi.
- Task can emit message to group.
- Run logged in `task_run_logs`.
- Next run/update status computed correctly.

---

### E2E-07: IPC Authorization (Main vs Non-Main)

**Goal:** Preserve privilege boundaries.

**Setup:**
- Non-main group attempts privileged action (e.g. register group or cross-group scheduling).
- Main group performs same action.

**Assertions:**
- Non-main attempt blocked.
- Main attempt allowed.
- Logs indicate authorization behavior.

---

### E2E-08: Group Isolation Integrity

**Goal:** Ensure no cross-group data leakage/regression.

**Setup:**
- Two registered groups execute tasks/messages concurrently.

**Assertions:**
- Group A cannot access Group B workspace/IPC namespace.
- Session/memory files are isolated per group.
- Global memory access semantics unchanged (main writable, others read-only).

---

### E2E-09: Error Handling & Retry Semantics

**Goal:** Validate failure path parity.

**Setup:**
- Induce deterministic runner/task failure.

**Assertions:**
- Message cursor rollback behavior matches current policy.
- No duplicate user-visible replies after partial failure.
- Exponential retry remains functional for message processing.

---

### E2E-10: Concurrency & Queue Drain Under Load

**Goal:** Validate queue correctness at/over concurrency limits.

**Setup:**
- Simulate messages from more groups than `MAX_CONCURRENT_CONTAINERS`.

**Assertions:**
- Active containers never exceed configured cap.
- Waiting groups eventually drain.
- No deadlock/starvation.

---

## Test Harness Requirements

1. Deterministic channel harness (fake channel implementation).
2. Ephemeral filesystem roots for `store/`, `data/`, `groups/`.
3. Real SQLite + real loops (message loop, scheduler, IPC watcher).
4. Deterministic model backend for Pi (mock/local provider) to avoid flaky live-model assertions.
5. Assertions on:
   - outbound channel events
   - DB state transitions
   - IPC artifacts
   - container logs and exit states

---

## CI Gating

Recommended pipelines:

1. `replacement-audit` → E2E-00
2. `e2e-core` → E2E-01..E2E-07
3. `e2e-stress` → E2E-08..E2E-10

Merge policy: all gates green.

---

## Out of Scope for This Spec

- UX-level prompt quality comparisons between Claude and Pi models.
- Provider-specific latency/cost benchmarks.
- Third-party channel skill installation flows.
