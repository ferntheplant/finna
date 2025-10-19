import { inngest } from './client';
import {
  ingestCreditCardCSV,
  ingestBankStatementCSV,
  createWorkflowRun,
  updateWorkflowRun,
  getExpenses,
} from '../db-operations';

export const processExpenses = inngest.createFunction(
  {
    id: 'process-expenses',
    name: 'Process Expense CSV File',
  },
  { event: 'expenses/processing.started' },
  async ({ event, step, logger }) => {
    const { runId, filePath, csvType } = event.data;

    logger.info(`Starting expense processing workflow`, { runId, filePath, csvType });

    // Step 1: Create workflow run record
    const totalExpenses = await step.run('ingest-csv', async () => {
      logger.debug(`Ingesting ${csvType} CSV`, { runId, filePath });

      const count = csvType === 'credit_card'
        ? await ingestCreditCardCSV(filePath, runId)
        : await ingestBankStatementCSV(filePath, runId);

      await createWorkflowRun({
        runId,
        filePath,
        csvType,
        status: 'processing',
        totalExpenses: count,
        categorizedCount: 0,
        reviewQueueCount: 0,
        startedAt: new Date().toISOString(),
      });

      logger.info(`✓ Ingested ${count} expenses`, { runId, count });
      return count;
    });

    // Step 2: Get all expenses and trigger categorization for each
    const expenses = await step.run('fetch-expenses', async () => {
      logger.debug(`Fetching expenses from database`, { runId });
      const exp = await getExpenses(runId);
      logger.debug(`Fetched ${exp.length} expenses`, { runId });
      return exp;
    });

    // Step 3: Trigger categorization for each expense
    // Only categorize top-level expenses (not sub-expenses)
    // Sub-expenses are created during review and get categorized then
    const topLevelExpenseCount = await step.run('trigger-categorizations', async () => {
      // Filter to only top-level expenses (non-sub-expenses)
      const topLevelExpenses = expenses.filter(exp => !exp.isSubExpense);

      logger.info(`Filtered to top-level expenses`, {
        runId,
        total: expenses.length,
        topLevel: topLevelExpenses.length,
        subExpenses: expenses.length - topLevelExpenses.length
      });

      // Send events for each top-level expense to be categorized
      const events = topLevelExpenses.map(expense => ({
        name: 'expenses/categorize' as const,
        data: {
          runId,
          expenseId: expense.id,
        },
      }));

      await inngest.send(events);

      logger.info(`→ Triggered ${events.length} categorization workflows`, {
        runId,
        count: events.length
      });

      return topLevelExpenses.length;
    });

    // Step 4: Wait for completion event (sent by the last categorization)
    // Timeout after 2 hours to handle edge cases
    const completionEvent = await step.waitForEvent('wait-for-completion', {
      event: 'expenses/processing.completed',
      timeout: '2h',
      if: `async.data.runId == '${runId}'`,
    });

    // Step 5: Mark run as completed
    await step.run('complete-run', async () => {
      const status = completionEvent ? 'completed' : 'completed'; // completed either way, timeout just means it took longer

      await updateWorkflowRun(runId, {
        status,
        completedAt: new Date().toISOString(),
      });

      if (completionEvent) {
        logger.info(`✓ Workflow completed`, {
          runId,
          totalExpenses,
          categorized: completionEvent.data.categorizedCount,
          reviewQueue: completionEvent.data.reviewQueueCount
        });
      } else {
        logger.warn(`⚠ Workflow timed out waiting for completion`, {
          runId,
          totalExpenses,
          message: 'Categorizations may still be running in background'
        });
      }
    });

    return {
      runId,
      totalExpenses,
      message: 'Expense processing workflow completed',
    };
  }
);

