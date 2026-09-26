export const DERIVED_EPISODE_OUTCOMES = [
  "success",
  "failed",
  "blocked",
  "aborted",
  "unknown"
] as const;

export type DerivedEpisodeOutcome =
  (typeof DERIVED_EPISODE_OUTCOMES)[number];

export interface DerivedEpisode {
  episodeId: string;
  projectionKey: string;
  projectionSchemaVersion: string;
  payloadDigest: string;
  provenanceGroup: string;
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
  authority: "episodic";
  instructionAuthority: "none";
  lifecycleState: "active";
  canonical: false;
  createdAt: string;
  firstIngestedAt: string;
  lastSeenAt: string;
  replayCount: number;
}
