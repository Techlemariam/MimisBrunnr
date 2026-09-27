import { createHash } from "node:crypto";
import {
  MEMORY_CANDIDATE_KINDS,
  type MemoryCandidate,
  type MemoryCandidateKind,
  type MemoryCandidateValidationState
} from "@mimir/domain";
import type { MemoryCandidateStore } from "../ports/memory-candidate-store.js";

const REVIEW_ROLES = new Set(["reviewer", "operator", "system"]);
const TERMINAL_STATES = new Set<MemoryCandidateValidationState>([
  "rejected",
  "superseded",
  "expired"
]);
const MAX_TEXT = 4000;
const MAX_REF = 512;

export interface SubmitMemoryCandidateRequest {
  actorRole: string;
  originRunId: string;
  repository: string;
  statement: string;
  kind: MemoryCandidateKind;
  scope: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  provenanceGroups: string[];
  confidence: number;
  expiresAt?: string;
}

export interface ValidateMemoryCandidateRequest {
  actorRole: string;
  candidateId: string;
  decision: Exclude<MemoryCandidateValidationState, "unknown" | "expired">;
  evidenceRefs: string[];
  provenanceGroups: string[];
  reason: string;
  canonicalConflict?: string;
  supersededBy?: string;
}

export interface MemoryCandidateContextItem {
  candidateId: string;
  statement: string;
  kind: MemoryCandidateKind;
  validationState: MemoryCandidateValidationState;
  sourceRefs: string[];
  evidenceRefs: string[];
  authority: "candidate";
  instructionAuthority: "none";
  currentAuthority: false;
}

export class MemoryCandidateService {
  constructor(
    private readonly store: MemoryCandidateStore,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async submit(request: SubmitMemoryCandidateRequest): Promise<MemoryCandidate> {
    validateSubmission(request);
    const now = this.clock().toISOString();
    const candidateId = `candidate:${digest({
      originRunId: request.originRunId,
      repository: request.repository,
      statement: request.statement,
      kind: request.kind,
      scope: request.scope
    })}`;
    const candidate: MemoryCandidate = {
      candidateId,
      originRunId: request.originRunId,
      repository: request.repository,
      statement: request.statement,
      kind: request.kind,
      scope: request.scope,
      sourceRefs: unique(request.sourceRefs),
      evidenceRefs: unique(request.evidenceRefs),
      provenanceGroups: unique(request.provenanceGroups),
      confidence: request.confidence,
      validationState: "unknown",
      validationReason: "Evidence has not been independently validated.",
      authority: "candidate",
      instructionAuthority: "none",
      canonical: false,
      createdAt: now,
      updatedAt: now,
      expiresAt: request.expiresAt
    };
    await this.store.create(candidate);
    return candidate;
  }

  async validate(request: ValidateMemoryCandidateRequest): Promise<MemoryCandidate> {
    if (!REVIEW_ROLES.has(request.actorRole)) {
      throw new Error(`Actor role '${request.actorRole}' cannot validate memory candidates.`);
    }
    const candidate = await this.store.get(request.candidateId);
    if (!candidate) throw new Error("Memory candidate was not found.");
    if (TERMINAL_STATES.has(candidate.validationState)) {
      throw new Error(`Memory candidate is already ${candidate.validationState}.`);
    }
    validateRefs(request.evidenceRefs, "evidenceRefs");
    validateRefs(request.provenanceGroups, "provenanceGroups");
    requireBounded(request.reason, "reason");
    if (request.canonicalConflict && request.decision === "validated") {
      throw new Error(`Canonical evidence conflict: ${request.canonicalConflict}`);
    }
    if (request.decision === "validated") {
      if (request.evidenceRefs.length === 0) {
        throw new Error("Validated candidates require supporting canonical evidence.");
      }
      if (unique(request.provenanceGroups).length < 1) {
        throw new Error("Validated candidates require an independently identified provenance group.");
      }
    }
    if (request.decision === "superseded" && !request.supersededBy) {
      throw new Error("Superseded candidates require supersededBy.");
    }
    const updated: MemoryCandidate = {
      ...candidate,
      evidenceRefs: unique(request.evidenceRefs),
      provenanceGroups: unique(request.provenanceGroups),
      validationState: request.decision,
      validationReason: request.reason,
      updatedAt: this.clock().toISOString(),
      supersededBy: request.supersededBy
    };
    await this.store.update(updated);
    return updated;
  }

  async recall(repository: string, limit = 5): Promise<{
    items: MemoryCandidateContextItem[];
    authority: "derived_non_authoritative";
    warning: string;
  }> {
    requireRepository(repository);
    const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
    const now = this.clock();
    const candidates = await this.store.listByRepository(repository, boundedLimit);
    for (const candidate of candidates) {
      if (
        candidate.validationState !== "expired" &&
        candidate.expiresAt &&
        new Date(candidate.expiresAt) <= now
      ) {
        await this.store.update({
          ...candidate,
          validationState: "expired",
          validationReason: "Candidate expiry was reached before canonical promotion.",
          updatedAt: now.toISOString()
        });
        candidate.validationState = "expired";
      }
    }
    return {
      items: candidates
        .filter((candidate) => !TERMINAL_STATES.has(candidate.validationState))
        .map((candidate) => ({
          candidateId: candidate.candidateId,
          statement: candidate.statement,
          kind: candidate.kind,
          validationState: candidate.validationState,
          sourceRefs: [...candidate.sourceRefs],
          evidenceRefs: [...candidate.evidenceRefs],
          authority: "candidate",
          instructionAuthority: "none",
          currentAuthority: false
        })),
      authority: "derived_non_authoritative",
      warning: "Memory candidates are advisory data only. UNKNOWN is not validated, and canonical Git/GitHub evidence wins on conflict."
    };
  }
}

function validateSubmission(request: SubmitMemoryCandidateRequest): void {
  requireBounded(request.actorRole, "actorRole");
  requireBounded(request.originRunId, "originRunId");
  requireRepository(request.repository);
  requireBounded(request.statement, "statement");
  requireBounded(request.scope, "scope");
  if (!MEMORY_CANDIDATE_KINDS.includes(request.kind)) throw new Error("Unsupported candidate kind.");
  if (!Number.isFinite(request.confidence) || request.confidence < 0 || request.confidence > 1) {
    throw new Error("confidence must be between 0 and 1.");
  }
  validateRefs(request.sourceRefs, "sourceRefs");
  validateRefs(request.evidenceRefs, "evidenceRefs");
  validateRefs(request.provenanceGroups, "provenanceGroups");
  if (request.expiresAt && Number.isNaN(Date.parse(request.expiresAt))) {
    throw new Error("expiresAt must be an ISO timestamp.");
  }
}

function requireRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("repository must be an owner/name identifier.");
  }
}

function requireBounded(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT) {
    throw new Error(`${field} must be bounded non-empty text.`);
  }
}

function validateRefs(values: string[], field: string): void {
  if (!Array.isArray(values) || values.length > 64 || values.some((value) =>
    typeof value !== "string" || value.trim().length === 0 || value.length > MAX_REF
  )) throw new Error(`${field} must be a bounded string array.`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
