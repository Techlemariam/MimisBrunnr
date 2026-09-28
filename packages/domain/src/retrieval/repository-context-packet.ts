export interface RepositoryContextPacketBudget {
  maxTokens: number;
  maxSources: number;
  maxRawExcerpts: number;
  maxSummarySentences: number;
}

export interface RepositoryContextPacketEvidence {
  repository: string;
  path: string;
  headingPath: string[];
  chunkId: string;
  excerpt?: string;
}

export interface RepositoryContextPacket {
  schemaVersion: "mimisbrunnr.repository-context-packet/v1";
  authority: "advisory";
  canonical: false;
  instructionAuthority: "none";
  repository: string;
  indexedRevision: string | "unknown";
  currentRevision: string | "unknown";
  validationFresh: boolean | "unknown";
  query: string;
  summary: string;
  evidence: RepositoryContextPacketEvidence[];
  warnings: string[];
  uncertainties: string[];
  budgetUsage: {
    tokenEstimate: number;
    sourceCount: number;
    rawExcerptCount: number;
  };
}
