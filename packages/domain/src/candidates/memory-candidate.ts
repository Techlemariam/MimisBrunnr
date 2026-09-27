export const MEMORY_CANDIDATE_KINDS = [
  "observation",
  "hypothesis",
  "procedural_lesson",
  "decision_candidate"
] as const;

export type MemoryCandidateKind = (typeof MEMORY_CANDIDATE_KINDS)[number];

export const MEMORY_CANDIDATE_VALIDATION_STATES = [
  "unknown",
  "validated",
  "rejected",
  "superseded",
  "expired"
] as const;

export type MemoryCandidateValidationState =
  (typeof MEMORY_CANDIDATE_VALIDATION_STATES)[number];

export interface MemoryCandidate {
  candidateId: string;
  originRunId: string;
  repository: string;
  statement: string;
  kind: MemoryCandidateKind;
  scope: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  provenanceGroups: string[];
  confidence: number;
  validationState: MemoryCandidateValidationState;
  validationReason: string;
  authority: "candidate";
  instructionAuthority: "none";
  canonical: false;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  supersededBy?: string;
}
