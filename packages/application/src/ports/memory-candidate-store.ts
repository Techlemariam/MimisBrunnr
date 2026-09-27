import type { MemoryCandidate } from "@mimir/domain";

export interface MemoryCandidateStore {
  create(candidate: MemoryCandidate): Promise<void>;
  get(candidateId: string): Promise<MemoryCandidate | undefined>;
  update(candidate: MemoryCandidate): Promise<void>;
  listByRepository(repository: string, limit: number): Promise<MemoryCandidate[]>;
}
