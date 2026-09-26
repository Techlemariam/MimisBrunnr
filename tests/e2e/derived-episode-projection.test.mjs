import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DerivedEpisodeProjectionService } from "../../packages/application/dist/index.js";
import { SqliteDerivedEpisodeStore } from "../../packages/infrastructure/dist/index.js";

function actor() {
  return {
    actorId: "capture-projector-test",
    actorRole: "system",
    transport: "internal",
    source: "test-suite",
    requestId: randomUUID(),
    initiatedAt: "2026-09-26T00:00:00.000Z"
  };
}

function projection(overrides = {}) {
  return {
    projectionSchemaVersion: "1.0.0",
    originRunId: "run-123",
    sourceRef: "github-issue://Panopticon-AB/panopticon-agents/28",
    repository: "Panopticon-AB/panopticon-agents",
    prRef: "github-pr://Panopticon-AB/panopticon-agents/99",
    exactHeadSha: "0123456789abcdef0123456789abcdef01234567",
    handoffSchemaVersion: "1.0.0",
    resultSchemaVersion: "2.0.0",
    evidenceSchemaVersion: "2.0.0",
    runOutcome: "success",
    reviewState: "reviewed",
    verificationRefs: ["github-check://example/check/1"],
    summary: "Bounded reviewed outcome; no raw conversation retained.",
    failureReasonCodes: [],
    ...overrides
  };
}

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimir-derived-episode-"));
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });
  const store = new SqliteDerivedEpisodeStore(path.join(state, "memory.sqlite"));
  const service = new DerivedEpisodeProjectionService(
    store,
    () => new Date("2026-09-26T12:00:00.000Z")
  );
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, service };
}

test("same canonical projection is an idempotent duplicate, not corroboration", async (t) => {
  const { service } = await harness(t);
  const request = { actor: actor(), projection: projection() };

  const first = await service.project(request);
  const second = await service.project({ actor: actor(), projection: projection() });

  assert.equal(first.ok, true);
  assert.equal(first.data.disposition, "created");
  assert.equal(second.ok, true);
  assert.equal(second.data.disposition, "duplicate_noop");
  assert.equal(second.data.episode.projectionKey, first.data.episode.projectionKey);
  assert.equal(second.data.episode.payloadDigest, first.data.episode.payloadDigest);
  assert.equal(second.data.episode.replayCount, 1);
  assert.equal(second.data.episode.authority, "episodic");
  assert.equal(second.data.episode.instructionAuthority, "none");
  assert.equal(second.data.episode.canonical, false);
});

test("changed payload for same logical run/head fails closed as conflict", async (t) => {
  const { service } = await harness(t);
  const first = await service.project({ actor: actor(), projection: projection() });
  assert.equal(first.ok, true);

  const conflict = await service.project({
    actor: actor(),
    projection: projection({ summary: "Altered replay must not overwrite history." })
  });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "projection_conflict");
});

test("new exact head creates a new historical projection", async (t) => {
  const { service } = await harness(t);
  const first = await service.project({ actor: actor(), projection: projection() });
  const second = await service.project({
    actor: actor(),
    projection: projection({
      exactHeadSha: "89abcdef0123456789abcdef0123456789abcdef"
    })
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.data.disposition, "created");
  assert.notEqual(second.data.episode.projectionKey, first.data.episode.projectionKey);
  assert.notEqual(second.data.episode.provenanceGroup, first.data.episode.provenanceGroup);
});

test("unbounded or ambiguous projection provenance is rejected", async (t) => {
  const { service } = await harness(t);
  const result = await service.project({
    actor: actor(),
    projection: projection({ exactHeadSha: "main" })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "validation_failed");
});
