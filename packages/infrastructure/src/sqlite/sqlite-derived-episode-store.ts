import { DatabaseSync } from "node:sqlite";
import type {
  DerivedEpisodePutResult,
  DerivedEpisodeStore
} from "@mimir/application";
import type { DerivedEpisode } from "@mimir/domain";
import {
  acquireSharedSqliteConnection,
  type SharedSqliteConnection
} from "./shared-sqlite-connection.js";

interface EpisodeRow {
  projection_key: string;
  payload_digest: string;
  episode_json: string;
  replay_count: number;
  first_ingested_at: string;
  last_seen_at: string;
}

export class SqliteDerivedEpisodeStore implements DerivedEpisodeStore {
  private readonly database: DatabaseSync;
  private readonly sharedConnection: SharedSqliteConnection;
  private closed = false;

  constructor(databasePath: string) {
    this.sharedConnection = acquireSharedSqliteConnection(databasePath);
    this.database = this.sharedConnection.database;
    this.initialize();
  }

  close(): void {
    if (this.closed) return;
    this.sharedConnection.release();
    this.closed = true;
  }

  async getByProjectionKey(projectionKey: string): Promise<DerivedEpisode | undefined> {
    const row = this.getRow(projectionKey);
    return row ? decodeEpisode(row) : undefined;
  }

  async listByRepository(repository: string, limit: number): Promise<DerivedEpisode[]> {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT projection_key, payload_digest, episode_json, replay_count,
             first_ingested_at, last_seen_at
      FROM derived_episodes
      WHERE repository = ?
      ORDER BY first_ingested_at DESC, projection_key ASC
      LIMIT ?
    `).all(repository, boundedLimit) as unknown as EpisodeRow[];
    return rows.map(decodeEpisode);
  }

  async putProjection(episode: DerivedEpisode): Promise<DerivedEpisodePutResult> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getRow(episode.projectionKey);
      if (existing) {
        if (existing.payload_digest !== episode.payloadDigest) {
          this.database.exec("COMMIT");
          return { disposition: "conflict", episode: decodeEpisode(existing) };
        }

        const replayCount = Number(existing.replay_count) + 1;
        this.database.prepare(`
          UPDATE derived_episodes
          SET replay_count = :replayCount,
              last_seen_at = :lastSeenAt
          WHERE projection_key = :projectionKey
        `).run({
          replayCount,
          lastSeenAt: episode.lastSeenAt,
          projectionKey: episode.projectionKey
        });
        const updated = this.getRow(episode.projectionKey);
        this.database.exec("COMMIT");
        return {
          disposition: "duplicate_noop",
          episode: decodeEpisode(updated ?? existing)
        };
      }

      this.database.prepare(`
        INSERT INTO derived_episodes (
          projection_key,
          payload_digest,
          provenance_group,
          source_ref,
          repository,
          pr_ref,
          exact_head_sha,
          authority,
          instruction_authority,
          lifecycle_state,
          first_ingested_at,
          last_seen_at,
          replay_count,
          episode_json
        ) VALUES (
          :projectionKey,
          :payloadDigest,
          :provenanceGroup,
          :sourceRef,
          :repository,
          :prRef,
          :exactHeadSha,
          :authority,
          :instructionAuthority,
          :lifecycleState,
          :firstIngestedAt,
          :lastSeenAt,
          :replayCount,
          :episodeJson
        )
      `).run({
        projectionKey: episode.projectionKey,
        payloadDigest: episode.payloadDigest,
        provenanceGroup: episode.provenanceGroup,
        sourceRef: episode.sourceRef,
        repository: episode.repository,
        prRef: episode.prRef,
        exactHeadSha: episode.exactHeadSha,
        authority: episode.authority,
        instructionAuthority: episode.instructionAuthority,
        lifecycleState: episode.lifecycleState,
        firstIngestedAt: episode.firstIngestedAt,
        lastSeenAt: episode.lastSeenAt,
        replayCount: episode.replayCount,
        episodeJson: JSON.stringify(episode)
      });
      this.database.exec("COMMIT");
      return { disposition: "created", episode };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private getRow(projectionKey: string): EpisodeRow | undefined {
    return this.database.prepare(`
      SELECT projection_key, payload_digest, episode_json, replay_count,
             first_ingested_at, last_seen_at
      FROM derived_episodes
      WHERE projection_key = ?
      LIMIT 1
    `).get(projectionKey) as EpisodeRow | undefined;
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS derived_episodes (
        projection_key TEXT PRIMARY KEY,
        payload_digest TEXT NOT NULL,
        provenance_group TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_ref TEXT NOT NULL,
        exact_head_sha TEXT NOT NULL,
        authority TEXT NOT NULL CHECK(authority = 'episodic'),
        instruction_authority TEXT NOT NULL CHECK(instruction_authority = 'none'),
        lifecycle_state TEXT NOT NULL,
        first_ingested_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        replay_count INTEGER NOT NULL DEFAULT 0,
        episode_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_derived_episodes_source
      ON derived_episodes (repository, source_ref, exact_head_sha);

      CREATE INDEX IF NOT EXISTS idx_derived_episodes_provenance_group
      ON derived_episodes (provenance_group);
    `);
  }
}

function decodeEpisode(row: EpisodeRow): DerivedEpisode {
  const episode = JSON.parse(row.episode_json) as DerivedEpisode;
  return {
    ...episode,
    firstIngestedAt: row.first_ingested_at,
    lastSeenAt: row.last_seen_at,
    replayCount: Number(row.replay_count)
  };
}
