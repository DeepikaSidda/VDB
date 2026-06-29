/**
 * Client-safe type re-exports. These are `import type` only, so they are erased
 * at build time and pull no server-only runtime code into the client bundle.
 */

export type {
  SessionSnapshot,
  SessionStatus,
  StageEvent,
  SavedGeneration,
  SchemaView,
  SchemaEntity,
  SchemaColumn,
  SchemaEdge,
} from './backend';

export type {
  GenerationStage,
} from '../../dist/src/model/types.js';

export type {
  DashboardDescriptor,
  EntityView,
  ColumnView,
} from '../../dist/src/dashboard/descriptor.js';

export type {
  ClarifyingQuestion,
  QuestionOption,
} from '../../dist/src/refinement/refinementEngine.js';

/** The shape returned by the list/search/filter endpoint. */
export type RecordsPage = {
  records: Record<string, unknown>[];
  total: number;
  isEmpty: boolean;
  page: number;
  pageSize: number;
};
