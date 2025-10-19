import { inngest } from './client';
import {
  getWorkflowRun,
  updateWorkflowRun,
} from '../db-operations';

export const trackRunCompletion = inngest.createFunction(
  {
    id: 'track-run-completion',
    name: 'Track Run Completion',
    batchEvents: {
      maxSize: 100,
      timeout: '5s',
    },
  },
  // Triggers on any expense completion event
  { event: 'expenses/expense.categorized' },
  async ({ events, step, logger }) => {
    logger.info(`Processing ${events.length} completion events`, {
      eventCount: events.length
    });

    // Step: Check each unique runId for completion
    await step.run('check-completions', async () => {
      // Group events by runId - filter to events with runId
      const runIds = [...new Set(
        events
          .filter(e => 'runId' in e.data)
          .map(e => (e.data as any).runId as string)
      )];

      logger.info(`Checking ${runIds.length} unique runs for completion`, {
        runIds
      });

      for (const runId of runIds) {
        const run = await getWorkflowRun(runId);

        if (!run || run.status !== 'processing') {
          logger.debug(`Skipping run (not processing)`, {
            runId,
            status: run?.status || 'not found'
          });
          continue;
        }

        const processedCount =
          run.categorizedCount +
          run.reviewQueueCount +
          run.failedCount;

        logger.debug(`Run progress`, {
          runId,
          categorized: run.categorizedCount,
          review: run.reviewQueueCount,
          failed: run.failedCount,
          processed: processedCount,
          total: run.totalExpenses
        });

        if (processedCount >= run.totalExpenses) {
          await updateWorkflowRun(runId, {
            status: 'categorization_done',
            completedAt: new Date().toISOString(),
          });

          logger.info(`✓ Run categorization completed`, {
            runId,
            categorized: run.categorizedCount,
            review: run.reviewQueueCount,
            failed: run.failedCount,
            total: run.totalExpenses,
          });
        }
      }
    });

    return {
      processedEvents: events.length,
      uniqueRuns: [...new Set(
        events
          .filter(e => 'runId' in e.data)
          .map(e => (e.data as any).runId as string)
      )].length,
    };
  }
);

// Also handle needs_review and failed events
export const trackRunCompletionFromReview = inngest.createFunction(
  {
    id: 'track-run-completion-from-review',
    name: 'Track Run Completion (from review)',
    batchEvents: {
      maxSize: 100,
      timeout: '5s',
    },
  },
  { event: 'expenses/expense.needs_review' },
  async ({ events, step, logger }) => {
    logger.info(`Processing ${events.length} review events`, {
      eventCount: events.length
    });

    await step.run('check-completions', async () => {
      const runIds = [...new Set(
        events
          .filter(e => 'runId' in e.data)
          .map(e => (e.data as any).runId as string)
      )];

      for (const runId of runIds) {
        const run = await getWorkflowRun(runId);

        if (!run || run.status !== 'processing') {
          continue;
        }

        const processedCount =
          run.categorizedCount +
          run.reviewQueueCount +
          run.failedCount;

        if (processedCount >= run.totalExpenses) {
          await updateWorkflowRun(runId, {
            status: 'categorization_done',
            completedAt: new Date().toISOString(),
          });

          logger.info(`✓ Run categorization completed (via review)`, {
            runId,
            categorized: run.categorizedCount,
            review: run.reviewQueueCount,
            failed: run.failedCount,
            total: run.totalExpenses,
          });
        }
      }
    });

    return {
      processedEvents: events.length,
      uniqueRuns: [...new Set(
        events
          .filter(e => 'runId' in e.data)
          .map(e => (e.data as any).runId as string)
      )].length,
    };
  }
);

export const trackRunCompletionFromFailure = inngest.createFunction(
  {
    id: 'track-run-completion-from-failure',
    name: 'Track Run Completion (from failure)',
    batchEvents: {
      maxSize: 100,
      timeout: '5s',
    },
  },
  { event: 'expenses/expense.failed' },
  async ({ events, step, logger }) => {
    logger.info(`Processing ${events.length} failure events`, {
      eventCount: events.length
    });

    await step.run('check-completions', async () => {
      const runIds = [...new Set(
        events
          .filter(e => 'runId' in e.data)
          .map(e => (e.data as any).runId as string)
      )];

      for (const runId of runIds) {
        const run = await getWorkflowRun(runId);

        if (!run || run.status !== 'processing') {
          continue;
        }

        const processedCount =
          run.categorizedCount +
          run.reviewQueueCount +
          run.failedCount;

        if (processedCount >= run.totalExpenses) {
          await updateWorkflowRun(runId, {
            status: 'categorization_done',
            completedAt: new Date().toISOString(),
          });

          logger.info(`✓ Run categorization completed (via failure)`, {
            runId,
            categorized: run.categorizedCount,
            review: run.reviewQueueCount,
            failed: run.failedCount,
            total: run.totalExpenses,
          });
        }
      }
    });

    return {
      processedEvents: events.length,
      uniqueRuns: [...new Set(
        events
          .filter(e => 'runId' in e.data)
          .map(e => (e.data as any).runId as string)
      )].length,
    };
  }
);

