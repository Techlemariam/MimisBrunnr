import type { ActorContext } from "../common/actor-context.js";
import type { DerivedEpisode, DerivedEpisodeOutcome } from "@mimir/domain";

export interface DerivedEpisodeProjectionInput {
  projectionSchemaVersion: string;
  originRunId: string;
  sourceRef: string;
  repository: string;
  prRef: string;
  exactHeadSha: string;
  handoffSchemaVersion: string;
  resultSchemaVersion: string;
  evidenceSchemaVersion: string;
  runOutcome: DerivedEpisodeOutcome;
  reviewState: string;
  verificationRefs: string[];
  summary: string;
  failureReasonCodes: string[];
}

export interface ProjectDerivedEpisodeRequest {
  actor: ActorContext;
  projection: DerivedEpisodeProjectionInput;
}

export type DerivedEpisodeProjectionDisposition =
  | "created"
  | "duplicate_noop"
  | "conflict";

export interface ProjectDerivedEpisodeResponse {
  disposition: DerivedEpisodeProjectionDisposition;
  episode: DerivedEpisode;
}
