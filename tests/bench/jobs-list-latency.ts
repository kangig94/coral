import { decodeProjectionJobExecutionOwner } from '#src/jobs/projection-row.js';
import { listJobProjections } from '#src/jobs/read-queries.js';
import { performance } from 'node:perf_hooks';
import { createJobsListHistory, coordinatorJobs } from '#tests/helpers/jobs-list-history.js';

for (const all of [false, true]) {
  const h = createJobsListHistory(3000);
  try {
    const jobs = coordinatorJobs(h);
    const times: number[] = [];
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now();
      jobs.list({ all });
      times.push(performance.now() - start);
    }
    h.db.prepare("UPDATE projection_jobs SET diagnostics = diagnostics WHERE job_id = 'job-00000'").run();
    const afterWrite = performance.now();
    jobs.list({ all });
    const afterWriteMs = performance.now() - afterWrite;
    console.log(
      JSON.stringify({
        all,
        coldMs: times[0],
        warmMedianMs: times.slice(1).sort((a, b) => a - b)[2],
        afterWriteMs,
        samples: times,
      }),
    );
  } finally {
    h.db.close();
  }
}

for (const terminalCount of [300, 3000]) {
  const h = createJobsListHistory(terminalCount);
  try {
    const owners = h.db
      .prepare<[], { job_id: string; execution_owner: string }>('SELECT job_id, execution_owner FROM projection_jobs')
      .all();
    const discussionKindJobs = owners.filter(
      (row) => decodeProjectionJobExecutionOwner(row).kind === 'discussion',
    ).length;
    const times: number[] = [];
    let selectedJobs = 0;
    for (let sample = 0; sample < 6; sample++) {
      const start = performance.now();
      selectedJobs = listJobProjections(h.db, h.readCtx, { all: true, discussionId: 'absent-discussion' }).length;
      times.push(performance.now() - start);
    }
    h.db.prepare("UPDATE projection_jobs SET diagnostics = diagnostics WHERE job_id = 'job-00000'").run();
    const afterWrite = performance.now();
    listJobProjections(h.db, h.readCtx, { all: true, discussionId: 'absent-discussion' });
    console.log(
      JSON.stringify({
        operation: 'discussion-owner-scan',
        projectedJobs: owners.length,
        discussionKindJobs,
        selectedJobs,
        coldMs: times[0],
        warmMedianMs: times.slice(1).sort((a, b) => a - b)[2],
        afterWriteMs: performance.now() - afterWrite,
      }),
    );
  } finally {
    h.db.close();
  }
}
