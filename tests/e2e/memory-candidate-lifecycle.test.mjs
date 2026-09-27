import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryCandidateService } from "../../packages/application/dist/index.js";
import { SqliteMemoryCandidateStore } from "../../packages/infrastructure/dist/index.js";

async function harness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mimir-candidate-"));
  const store = new SqliteMemoryCandidateStore(path.join(root, "memory.sqlite"));
  const service = new MemoryCandidateService(
    store,
    () => new Date("2026-09-27T12:00:00.000Z")
  );
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service, store };
}

function submission(overrides = {}) {
  return {
    actorRole: "writer",
    originRunId: "run-a",
    repository: "Panopticon-AB/panopticon-agents",
    statement: "Invented claim X should be treated as a hypothesis.",
    kind: "hypothesis",
    scope: "repository",
    sourceRefs: ["github-issue://Panopticon-AB/panopticon-agents/9"],
    evidenceRefs: [],
    provenanceGroups: ["run:run-a"],
    confidence: 0.4,
    ...overrides
  };
}

test("agent submission remains UNKNOWN, non-canonical, and advisory", async (t) => {
  const { service } = await harness(t);
  const candidate = await service.submit(submission());

  assert.equal(candidate.validationState, "unknown");
  assert.equal(candidate.authority, "candidate");
  assert.equal(candidate.instructionAuthority, "none");
  assert.equal(candidate.canonical, false);

  const recalled = await service.recall("Panopticon-AB/panopticon-agents", 50);
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].validationState, "unknown");
  assert.equal(recalled.items[0].currentAuthority, false);
  assert.match(recalled.warning, /UNKNOWN is not validated/);
  assert.match(recalled.warning, /canonical Git\/GitHub evidence wins/);
});

test("writer cannot validate or promote an invented claim", async (t) => {
  const { service } = await harness(t);
  const candidate = await service.submit(submission());

  await assert.rejects(
    service.validate({
      actorRole: "writer",
      candidateId: candidate.candidateId,
      decision: "validated",
      evidenceRefs: ["github-check://example/1"],
      provenanceGroups: ["review:1"],
      reason: "Self-attested by the producing agent."
    }),
    /cannot validate memory candidates/
  );
  assert.equal(typeof service.promote, "undefined");
});

test("missing evidence cannot become validated", async (t) => {
  const { service } = await harness(t);
  const candidate = await service.submit(submission());

  await assert.rejects(
    service.validate({
      actorRole: "reviewer",
      candidateId: candidate.candidateId,
      decision: "validated",
      evidenceRefs: [],
      provenanceGroups: ["review:1"],
      reason: "No canonical evidence exists."
    }),
    /require supporting canonical evidence/
  );
});

test("replayed provenance is deduplicated and does not become corroboration", async (t) => {
  const { service } = await harness(t);
  const candidate = await service.submit(submission({
    provenanceGroups: ["run:run-a", "run:run-a", "run:run-a"]
  }));
  assert.deepEqual(candidate.provenanceGroups, ["run:run-a"]);

  const rejected = await service.validate({
    actorRole: "reviewer",
    candidateId: candidate.candidateId,
    decision: "rejected",
    evidenceRefs: [],
    provenanceGroups: ["run:run-a", "run:run-a"],
    reason: "The claim has no supporting canonical evidence."
  });
  assert.equal(rejected.validationState, "rejected");
  assert.deepEqual(rejected.provenanceGroups, ["run:run-a"]);

  const recalled = await service.recall("Panopticon-AB/panopticon-agents");
  assert.equal(recalled.items.length, 0);
});

test("independent reviewer can validate evidence without creating canonical state", async (t) => {
  const { service } = await harness(t);
  const candidate = await service.submit(submission());
  const validated = await service.validate({
    actorRole: "reviewer",
    candidateId: candidate.candidateId,
    decision: "validated",
    evidenceRefs: ["github-blob://Panopticon-AB/panopticon-agents/0123456789abcdef0123456789abcdef01234567/docs/example.md"],
    provenanceGroups: ["review:independent-1"],
    reason: "An independent canonical source supports the bounded statement."
  });

  assert.equal(validated.validationState, "validated");
  assert.equal(validated.authority, "candidate");
  assert.equal(validated.canonical, false);
  assert.equal(typeof service.promote, "undefined");
});

test("canonical conflict wins and blocks validation", async (t) => {
  const { service } = await harness(t);
  const candidate = await service.submit(submission());

  await assert.rejects(
    service.validate({
      actorRole: "reviewer",
      candidateId: candidate.candidateId,
      decision: "validated",
      evidenceRefs: ["github-blob://Panopticon-AB/panopticon-agents/0123456789abcdef0123456789abcdef01234567/docs/example.md"],
      provenanceGroups: ["review:independent-1"],
      reason: "Attempted validation despite conflict.",
      canonicalConflict: "Current Git content contradicts claim X."
    }),
    /Canonical evidence conflict/
  );
});

test("expired candidates transition to expired and are excluded from recall", async (t) => {
  const { service, store } = await harness(t);
  const candidate = await service.submit(submission({
    expiresAt: "2026-09-27T11:59:59.000Z"
  }));

  const recalled = await service.recall("Panopticon-AB/panopticon-agents");
  assert.equal(recalled.items.length, 0);
  const stored = await store.get(candidate.candidateId);
  assert.equal(stored?.validationState, "expired");
});
