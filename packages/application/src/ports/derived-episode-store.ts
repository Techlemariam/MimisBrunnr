import type { DerivedEpisode } from "@mimir/domain";

export type DerivedEpisodePutResult =
  | { disposition: "created"; episode: DerivedEpisode }
  | { disposition: "duplicate_noop"; episode: DerivedEpisode }
  | { disposition: "conflict"; episode: DerivedEpisode };

export interface DerivedEpisodeStore {
  putProjection(episode: DerivedEpisode): Promise<DerivedEpisodePutResult>;
  getByProjectionKey(projectionKey: string): Promise<DerivedEpisode | undefined>;
}
