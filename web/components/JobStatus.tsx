'use client';

import type { GenerationStage, SessionSnapshot } from '@/lib/clientTypes';

/** The happy-path stage sequence, for rendering an ordered timeline. */
const STAGE_SEQUENCE: GenerationStage[] = [
  'SUBMITTED',
  'MODELING',
  'REFINING',
  'SCHEMA_GEN',
  'VERIFYING',
  'DEPLOYING',
  'API_GEN',
  'DEPLOYED',
];

/**
 * The job-status view (Req 9.2): renders the orchestrator's stage progression
 * as it advances and, on failure, the failing stage + reason. The large-model
 * "30s not guaranteed" notice (Req 9.5) is surfaced when present.
 */
export function JobStatus({ snapshot }: { snapshot: SessionSnapshot }) {
  const failed = snapshot.status === 'failed';
  const failedStage = snapshot.failure?.stage;
  const reachedIndex = STAGE_SEQUENCE.indexOf(snapshot.stage);

  return (
    <section className="panel">
      <h2>
        {snapshot.status === 'running' && <span className="spinner" />}
        Generation status:{' '}
        <span
          style={{
            color:
              snapshot.status === 'deployed'
                ? 'var(--ok)'
                : failed
                ? 'var(--err)'
                : 'var(--accent)',
          }}
        >
          {snapshot.status}
        </span>
      </h2>

      {snapshot.notice && <div className="notice-box">{snapshot.notice}</div>}

      <div className="stages">
        {STAGE_SEQUENCE.map((stage, idx) => {
          let cls = 'stage-chip';
          if (failed && stage === failedStage) {
            cls += ' failed';
          } else if (!failed && stage === snapshot.stage) {
            cls += ' active';
          } else if (reachedIndex >= 0 && idx < reachedIndex) {
            cls += ' done';
          } else if (snapshot.status === 'deployed') {
            cls += ' done';
          }
          return (
            <span key={stage} className={cls}>
              {stage}
            </span>
          );
        })}
        {failed && snapshot.stage === 'FAILED' && failedStage === undefined && (
          <span className="stage-chip failed">FAILED</span>
        )}
      </div>

      {failed && snapshot.failure && (
        <div className="error-box">
          <strong>Failed at {snapshot.failure.stage}:</strong>{' '}
          {snapshot.failure.reason}
        </div>
      )}
    </section>
  );
}
