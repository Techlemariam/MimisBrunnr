import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("apps/mimir-cli/dist/main.js");

test("repo evaluation CLI indexes tracked files and answers with source-path citations", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mimir-repo-eval-"));
  const repo = path.join(workspace, "repo");
  const indexPath = path.join(workspace, "index", "repo-index.json");
  await mkdir(path.join(repo, "docs", "runbooks"), { recursive: true });
  await mkdir(path.join(repo, "docs", "ai-agents"), { recursive: true });
  await mkdir(path.join(repo, "docs", "security"), { recursive: true });
  await mkdir(path.join(repo, "docs", "evaluations"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Demo\n\nRepository overview.\n", "utf8");
  await writeFile(
    path.join(repo, "docs", "runbooks", "restore-test-runbook.md"),
    [
      "# Restore Test Runbook",
      "",
      "## Purpose",
      "",
      "Backup is not trusted until restore has been tested.",
      "Rollback needs explicit operator approval."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(repo, "docs", "ai-agents", "agent-prompt-quality-standard.md"),
    [
      "# Agent Prompt Quality Standard",
      "",
      "Prompts should list files to inspect first, acceptance criteria, validation, risk, and rollback.",
      "Documentation-only work should cite source documents instead of eval suites."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(repo, "docs", "security", "approval-gate-matrix.md"),
    [
      "# Approval Gate Matrix",
      "",
      "Telegram and OpenClaw automation require explicit operator approval before risky commands.",
      "Public ingress and unaudited deployment actions are blocked."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(repo, "docs", "evaluations", "suite.md"),
    "# Eval Suite\n\nVilka dokument beskriver restore, backup, rollback, prompt och approval?\n",
    "utf8"
  );
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "README.md", "docs"], { cwd: repo });

  const index = await runCli("index-repo", {
    root: repo,
    include: ["README.md", "docs/"],
    outputPath: indexPath
  });
  assert.equal(index.ok, true);
  assert.equal(index.fileCount, 5);
  assert.equal(index.indexPath, indexPath);

  const answer = await runCli("answer-repo", {
    indexPath,
    query: "Vilka dokument beskriver restore, backup och rollback?",
    excludeFromAnswer: ["docs/evaluations/"],
    maxSources: 3
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.citations[0].path, "docs/runbooks/restore-test-runbook.md");
  assert.ok(answer.citations[0].scoreBreakdown.termScore > 0);
  assert.ok(Array.isArray(answer.retrievalHealth.topCandidates));
  assert.equal(answer.retrievalHealth.topCandidates[0].path, "docs/runbooks/restore-test-runbook.md");
  assert.equal(
    answer.citations.some((citation) => citation.path.startsWith("docs/evaluations/")),
    false
  );

  const packetAnswer = await runCli("answer-repo", {
    indexPath,
    repository: "example/panopticon",
    query: "Vilka dokument beskriver restore, backup och rollback?",
    excludeFromAnswer: ["docs/evaluations/"],
    contextPacketBudget: {
      maxTokens: 500,
      maxSources: 2,
      maxRawExcerpts: 1,
      maxSummarySentences: 1
    }
  });
  assert.equal(packetAnswer.contextPacket.schemaVersion, "mimisbrunnr.repository-context-packet/v1");
  assert.equal(packetAnswer.contextPacket.authority, "advisory");
  assert.equal(packetAnswer.contextPacket.canonical, false);
  assert.equal(packetAnswer.contextPacket.instructionAuthority, "none");
  assert.equal(packetAnswer.contextPacket.repository, "example/panopticon");
  assert.ok(packetAnswer.contextPacket.budgetUsage.tokenEstimate <= 500);
  assert.ok(packetAnswer.contextPacket.budgetUsage.sourceCount <= 2);
  assert.ok(packetAnswer.contextPacket.budgetUsage.rawExcerptCount <= 1);
  assert.equal(
    packetAnswer.contextPacket.evidence.some((item) => item.path.startsWith("docs/evaluations/")),
    false
  );

  const missingAnswer = await runCli("answer-repo", {
    indexPath,
    repository: "example/panopticon",
    query: "zzyzxquux",
    contextPacketBudget: {
      maxTokens: 500,
      maxSources: 2,
      maxRawExcerpts: 0,
      maxSummarySentences: 1
    }
  });
  assert.equal(missingAnswer.contextPacket.evidence.length, 0);
  assert.match(missingAnswer.contextPacket.uncertainties.join("\n"), /no repository evidence/i);

  const missingNamedPolicy = await runCli("answer-repo", {
    indexPath,
    repository: "example/panopticon",
    query: "Where is the canonical policy for the fictional ZEPHYR_ORANGE production override?",
    contextPacketBudget: {
      maxTokens: 500,
      maxSources: 2,
      maxRawExcerpts: 0,
      maxSummarySentences: 1
    }
  });
  assert.equal(missingNamedPolicy.contextPacket.evidence.length, 0);
  assert.match(missingNamedPolicy.contextPacket.uncertainties.join("\n"), /zephyr_orange/i);

  await assert.rejects(
    runCli("answer-repo", {
      indexPath,
      query: "restore",
      contextPacketBudget: {
        maxTokens: 500,
        maxSources: 2,
        maxRawExcerpts: 0,
        maxSummarySentences: 1
      }
    })
  );

  const evaluation = await runCli("eval-repo", {
    indexPath,
    tests: [
      {
        id: "restore-docs",
        prompt: "Vilka dokument beskriver restore, backup och rollback?",
        expectedFiles: ["docs/runbooks/restore-test-runbook.md"],
        expectedAnyFiles: [["README.md", "docs/runbooks/restore-test-runbook.md"]],
        forbiddenFiles: ["docs/evaluations/suite.md"],
        mustIncludeTerms: ["restore"],
        requireGroundedTerms: true,
        forbiddenTerms: ["untrusted"],
        maxExpectedRank: 1,
        excludeFromAnswer: ["docs/evaluations/"]
      },
      {
        id: "prompt-generation",
        prompt: "Generera en Codex-prompt for dokumentation-only restore-testbarhet.",
        expectedFiles: ["docs/ai-agents/agent-prompt-quality-standard.md"],
        forbiddenFiles: ["docs/evaluations/suite.md"],
        mustIncludeTerms: ["acceptance criteria"],
        requireGroundedTerms: true,
        forbiddenTerms: ["criterion leak"],
        maxExpectedRank: 1,
        excludeFromAnswer: ["docs/evaluations/"],
        intentHint: "prompt_generation"
      },
      {
        id: "security-reasoning",
        prompt: "Vilka regler stoppar Telegram och OpenClaw fran public ingress utan approval?",
        expectedFiles: ["docs/security/approval-gate-matrix.md"],
        forbiddenFiles: ["docs/evaluations/suite.md"],
        mustIncludeTerms: ["approval"],
        requireGroundedTerms: true,
        forbiddenTerms: ["root shell"],
        maxExpectedRank: 1,
        excludeFromAnswer: ["docs/evaluations/"],
        intentHint: "security_reasoning"
      }
    ],
    maxSources: 3
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.summary.pass, 3);
  assert.equal(evaluation.summary.passRate, 1);
  assert.equal(evaluation.summary.groundedTermRate, 1);
  assert.equal(evaluation.summary.forbiddenViolationCount, 0);
  assert.equal(evaluation.summary.scoreOutOf10, 10);
  assert.equal(evaluation.results[0].status, "PASS");
  assert.equal(evaluation.results[0].coverage.matchedExpectedFiles, 1);
  assert.equal(evaluation.results[0].coverage.rankEligibleExpectedFiles, 1);
  assert.equal(evaluation.results[0].rankMetrics.bestExpectedRank, 1);
  assert.equal(evaluation.results[0].rankMetrics.meanReciprocalRank, 1);
  assert.equal(evaluation.results[0].coverage.citedForbiddenTerms, 0);
  assert.equal(evaluation.results[0].coverage.ungroundedTerms, 0);
  assert.equal(evaluation.results[0].citationQuality, true);
  assert.equal(evaluation.results[1].status, "PASS");
  assert.equal(evaluation.results[1].intent, "prompt_generation");
  assert.equal(
    evaluation.results[1].citations.some((citation) => citation.path.startsWith("docs/evaluations/")),
    false
  );
  assert.equal(evaluation.results[2].status, "PASS");
  assert.equal(evaluation.results[2].intent, "security_reasoning");
  assert.equal(evaluation.results[2].citations[0].path, "docs/security/approval-gate-matrix.md");
  assert.equal(evaluation.results[2].rankMetrics.expectedFileRanks[0].rank, 1);
  assert.ok(evaluation.results[2].citations[0].scoreBreakdown.pathScore > 0);

  const ungroundedEvaluation = await runCli("eval-repo", {
    indexPath,
    tests: [
      {
        id: "ungrounded-term",
        prompt: "Vilka dokument beskriver restore och hallucinated-policy?",
        expectedFiles: ["docs/runbooks/restore-test-runbook.md"],
        mustIncludeTerms: ["hallucinated-policy"],
        requireGroundedTerms: true,
        excludeFromAnswer: ["docs/evaluations/"]
      }
    ],
    maxSources: 3
  });
  assert.equal(ungroundedEvaluation.ok, true);
  assert.equal(ungroundedEvaluation.results[0].status, "PARTIAL");
  assert.deepEqual(ungroundedEvaluation.results[0].ungroundedTerms, ["hallucinated-policy"]);
  assert.match(
    ungroundedEvaluation.results[0].statusReason,
    /required term\(s\) not grounded in cited sources/
  );
});

test("repo evaluation reports exact revision freshness and rejects old HEAD as fresh", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mimir-repo-revision-"));
  const repo = path.join(workspace, "repo");
  const indexPath = path.join(workspace, "index", "repo-index.json");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Revision one\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Mimir Test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "mimir-test@example.invalid"], { cwd: repo });
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "first"], { cwd: repo });
  const firstRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  const index = await runCli("index-repo", {
    root: repo,
    include: ["README.md"],
    outputPath: indexPath
  });
  assert.equal(index.indexedRevision, firstRevision);

  const fresh = await runCli("answer-repo", {
    indexPath,
    query: "revision one"
  });
  assert.equal(fresh.retrievalHealth.revision.validationFresh, true);
  assert.equal(fresh.retrievalHealth.revision.indexedRevision, firstRevision);

  await writeFile(path.join(repo, "README.md"), "# Revision two\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "second"], { cwd: repo });
  const secondRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  const stale = await runCli("answer-repo", {
    indexPath,
    query: "revision one"
  });
  assert.equal(stale.retrievalHealth.revision.validationFresh, false);
  assert.equal(stale.retrievalHealth.revision.indexedRevision, firstRevision);
  assert.equal(stale.retrievalHealth.revision.currentRevision, secondRevision);
  assert.match(stale.warnings.join("\n"), /index is stale/i);

  const stalePacket = await runCli("answer-repo", {
    indexPath,
    repository: "example/revision-test",
    query: "revision one",
    contextPacketBudget: {
      maxTokens: 500,
      maxSources: 2,
      maxRawExcerpts: 0,
      maxSummarySentences: 1
    }
  });
  assert.equal(stalePacket.contextPacket.validationFresh, false);
  assert.equal(stalePacket.contextPacket.indexedRevision, firstRevision);
  assert.equal(stalePacket.contextPacket.currentRevision, secondRevision);
  assert.match(stalePacket.contextPacket.uncertainties.join("\n"), /stale/i);
});

async function runCli(command, payload) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cliPath, command, "--json", JSON.stringify(payload), "--no-pretty"],
    { cwd: path.resolve(".") }
  );
  return JSON.parse(stdout);
}
