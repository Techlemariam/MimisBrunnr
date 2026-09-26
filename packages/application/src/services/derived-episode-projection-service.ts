import { createHash } from "node:crypto";
import type {
  ProjectDerivedEpisodeRequest,
  ProjectDerivedEpisodeResponse,
  ServiceResult
} from "@mimir/contracts";
import {
  DERIVED_EPISODE_OUTCOMES,
  type DerivedEpisode
} from "@mimir/domain";
import type { DerivedEpisodeStore } from "../ports/derived-episode-store.js";

type ProjectionErrorCode = "validation_failed" | "projection_conflict" | "write_failed";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_REF_LENGTH = 512;

export class DerivedEpisodeProjectionService {
  constructor(
    private readonly store: DerivedEpisodeStore,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async project(
    request: ProjectDerivedEpisodeRequest
  ): Promise<ServiceResult<ProjectDerivedEpisodeResponse, ProjectionErrorCode>> {
    const error = validateRequest(request);
    if (error) {
      return { ok: false, error: { code: "validation_failed", message: error } };
    }

    const input = request.projection;
    const projectionKey = digest({
      projectionSchemaVersion: input.projectionSchemaVersion,
      originRunId: input.originRunId,
      sourceRef: input.sourceRef,
      repository: input.repository,
      prRef: input.prRef,
      exactHeadSha: input.exactHeadSha
    });
    const provenanceGroup = digest({
      originRunId: input.originRunId,
      sourceRef: input.sourceRef,
      repository: input.repository,
      prRef: input.prRef,
      exactHeadSha: input.exactHeadSha
    });
    const payloadDigest = digest({
      projectionSchemaVersion: input.projectionSchemaVersion,
      originRunId: input.originRunId,
      sourceRef: input.sourceRef,
      repository: input.repository,
      prRef: input.prRef,
      exactHeadSha: input.exactHeadSha,
      handoffSchemaVersion: input.handoffSchemaVersion,
      resultSchemaVersion: input.resultSchemaVersion,
      evidenceSchemaVersion: input.evidenceSchemaVersion,
      runOutcome: input.runOutcome,
      reviewState: input.reviewState,
      verificationRefs: [...input.verificationRefs].sort(),
      summary: input.summary,
      failureReasonCodes: [...input.failureReasonCodes].sort()
    });
    const now = this.clock().toISOString();
    const episode: DerivedEpisode = {
      episodeId: `episode:${projectionKey}`,
      projectionKey,
      projectionSchemaVersion: input.projectionSchemaVersion,
      payloadDigest,
      provenanceGroup,
      originRunId: input.originRunId,
      sourceRef: input.sourceRef,
      repository: input.repository,
      prRef: input.prRef,
      exactHeadSha: input.exactHeadSha,
      handoffSchemaVersion: input.handoffSchemaVersion,
      resultSchemaVersion: input.resultSchemaVersion,
      evidenceSchemaVersion: input.evidenceSchemaVersion,
      runOutcome: input.runOutcome,
      reviewState: input.reviewState,
      verificationRefs: [...input.verificationRefs],
      summary: input.summary,
      failureReasonCodes: [...input.failureReasonCodes],
      authority: "episodic",
      instructionAuthority: "none",
      lifecycleState: "active",
      canonical: false,
      createdAt: now,
      firstIngestedAt: now,
      lastSeenAt: now,
      replayCount: 0
    };

    try {
      const stored = await this.store.putProjection(episode);
      if (stored.disposition === "conflict") {
        return {
          ok: false,
          error: {
            code: "projection_conflict",
            message: "Projection key is already bound to a different canonical payload."
          }
        };
      }
      return {
        ok: true,
        data: {
          disposition: stored.disposition,
          episode: stored.episode
        }
      };
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "write_failed",
          message: "Failed to persist derived episode projection.",
          details: { reason: cause instanceof Error ? cause.message : String(cause) }
        }
      };
    }
  }
}

function validateRequest(request: ProjectDerivedEpisodeRequest): string | undefined {
  const input = request?.projection;
  if (!input) return "projection is required";
  for (const version of [
    input.projectionSchemaVersion,
    input.handoffSchemaVersion,
    input.resultSchemaVersion,
    input.evidenceSchemaVersion
  ]) {
    if (!VERSION_PATTERN.test(version)) return "schema versions must use SemVer";
  }
  if (!DERIVED_EPISODE_OUTCOMES.includes(input.runOutcome)) return "run outcome is unsupported";
  if (!SHA_PATTERN.test(input.exactHeadSha)) return "exactHeadSha must be a full lowercase commit SHA";
  for (const value of [input.originRunId, input.sourceRef, input.repository, input.prRef, input.reviewState]) {
    if (!value?.trim() || value.length > MAX_REF_LENGTH) return "projection provenance fields must be bounded non-empty strings";
  }
  if (input.summary.trim().length === 0 || input.summary.length > MAX_SUMMARY_LENGTH) {
    return "summary must be bounded non-empty text";
  }
  if (!isBoundedStringArray(input.verificationRefs) || !isBoundedStringArray(input.failureReasonCodes)) {
    return "verificationRefs and failureReasonCodes must be bounded string arrays";
  }
  return undefined;
}

function isBoundedStringArray(values: string[]): boolean {
  return Array.isArray(values) && values.length <= 64 && values.every((value) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= MAX_REF_LENGTH
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
