# Seeding Announcer One-Cycle Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the seeding announcer post at most one automatic BEGUN and one COMPLETE per day, eliminating the once-per-minute spam loop.

**Architecture:** Simplify `decideSeedingAction` to `complete | update | noop` only. Monitor never creates sessions. Daily clock + staff send-now are the only BEGUN sources. Multi-role join/leave via `role_ids`. Drop `reset_threshold` from product surface.

**Tech Stack:** Bun, discord.js, MariaDB, existing seeding modules; webpage Hono API + React admin.

**Spec:** `docs/superpowers/specs/2026-07-22-seeding-announcer-one-cycle-design.md`

## Global Constraints

- Conventional commits, no AI attribution
- Behavior-only for embeds (no copy redesign)
- DB column `reset_threshold` may remain; bot/UI ignore/remove
- Version bump bot patch after changes

---

### Task 1: Rewrite `decideSeedingAction` + tests

**Files:**
- Modify: `src/services/seeding/seedingLogic.js`
- Modify: `src/services/seeding/__tests__/seedingLogic.test.js`

- [ ] Replace logic with three-action API
- [ ] Rewrite tests (complete / update / noop only)
- [ ] `bun test src/services/seeding/__tests__/seedingLogic.test.js`

### Task 2: Wire scheduler (remove reseed/reset)

**Files:**
- Modify: `src/services/seeding/seedingScheduler.js`

- [ ] Drop reseed/reset inputs and switch cases
- [ ] Stop importing `getLastSessionStartedAt`, `resetSession` if unused
- [ ] Export `updateCallMessage` (or a refresh helper) for send-now reuse

### Task 3: send-now active-session guard

**Files:**
- Modify: `src/services/actionProcessor.js`
- Modify: `src/services/seeding/seedingScheduler.js` (helpers)

- [ ] Active session → refresh call message only
- [ ] No session → `postSeedingCall` + `setLastDailyCallDate(today)`

### Task 4: Multi-role join/leave buttons

**Files:**
- Modify: `src/handlers/seedingButtons.js`

- [ ] Use `cfg.role_ids`; add/remove all; count from first role

### Task 5: Settings cleanup + version

**Files:**
- Modify: `settings.development.js`, `settings.staging.js`, `settings.production.js`
- Modify: `package.json` version → `2.34.1`
- Modify: `src/services/seeding/seedingService.js` if defaults reference reset threshold only for insert (keep column default)

### Task 6: Website remove resetThreshold

**Files:**
- Modify: `packages/shared/types/discord-bot.ts`
- Modify: `packages/api/src/routes/discord-bot/seeding.ts`
- Modify: `packages/web/app/(protected)/seeding/components/SeedingAdmin.tsx`

### Task 7: Verify, commit, deploy staging → prod

- [ ] `bun test` in bot repo
- [ ] Commit bot + webpage
- [ ] Push bot `main` (staging), merge to `production`
- [ ] Re-enable `seeding_config.enabled` if needed
