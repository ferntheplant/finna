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
        failedCount: 0,
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
    await step.run('trigger-categorizations', async () => {
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

      // Send all events at once - Inngest's throttling will handle the spacing
      // The throttle config (2 per 15s) will automatically queue and space them out
      await inngest.send(events);

      logger.info(`✓ Triggered ${events.length} categorization workflows`, {
        runId,
        count: events.length,
        note: 'Throttling will space these at 2 per 15 seconds'
      });

      return topLevelExpenses.length;
    });

    // Workflow completes here - categorizations will run in background
    // Completion is tracked by the trackRunCompletion workflow
    logger.info(`✓ Process expenses workflow completed`, {
      runId,
      totalExpenses,
      message: 'Categorization workflows triggered and running in background'
    });

    return {
      runId,
      totalExpenses,
      status: 'categorization_started',
      message: 'Categorization workflows triggered successfully',
    };
  }
);

