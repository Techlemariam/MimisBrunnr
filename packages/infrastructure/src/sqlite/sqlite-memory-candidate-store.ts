import { DatabaseSync } from "node:sqlite";
import type { MemoryCandidateStore } from "@mimir/application";
import type { MemoryCandidate } from "@mimir/domain";
import {
  acquireSharedSqliteConnection,
  type SharedSqliteConnection
} from "./shared-sqlite-connection.js";

interface CandidateRow { candidate_json: string }

export class SqliteMemoryCandidateStore implements MemoryCandidateStore {
  private readonly database: DatabaseSync;
  private readonly sharedConnection: SharedSqliteConnection;
  private closed = false;

  constructor(databasePath: string) {
    this.sharedConnection = acquireSharedSqliteConnection(databasePath);
    this.database = this.sharedConnection.database;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_candidates (
        candidate_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        validation_state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        candidate_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_repository
      ON memory_candidates (repository, updated_at DESC);
    `);
  }

  close(): void {
    if (this.closed) return;
    this.sharedConnection.release();
    this.closed = true;
  }

  async create(candidate: MemoryCandidate): Promise<void> {
    this.database.prepare(`
      INSERT INTO memory_candidates (
        candidate_id, repository, validation_state, updated_at, candidate_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      candidate.candidateId,
      candidate.repository,
      candidate.validationState,
      candidate.updatedAt,
      JSON.stringify(candidate)
    );
  }

  async get(candidateId: string): Promise<MemoryCandidate | undefined> {
    const row = this.database.prepare(`
      SELECT candidate_json FROM memory_candidates WHERE candidate_id = ? LIMIT 1
    `).get(candidateId) as CandidateRow | undefined;
    return row ? JSON.parse(row.candidate_json) as MemoryCandidate : undefined;
  }

  async update(candidate: MemoryCandidate): Promise<void> {
    const result = this.database.prepare(`
      UPDATE memory_candidates
      SET validation_state = ?, updated_at = ?, candidate_json = ?
      WHERE candidate_id = ?
    `).run(
      candidate.validationState,
      candidate.updatedAt,
      JSON.stringify(candidate),
      candidate.candidateId
    );
    if (Number(result.changes) !== 1) throw new Error("Memory candidate was not found.");
  }

  async listByRepository(repository: string, limit: number): Promise<MemoryCandidate[]> {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT candidate_json FROM memory_candidates
      WHERE repository = ?
      ORDER BY updated_at DESC, candidate_id ASC
      LIMIT ?
    `).all(repository, boundedLimit) as unknown as CandidateRow[];
    return rows.map((row) => JSON.parse(row.candidate_json) as MemoryCandidate);
  }
}
