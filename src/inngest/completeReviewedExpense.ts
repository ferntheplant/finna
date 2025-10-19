import { inngest } from './client';
import {
  getReviewQueueItem,
  getExpense,
  saveCategorization,
  resolveReviewQueueItem,
  getWorkflowRun,
  updateWorkflowRun,
} from '../db-operations';

export const completeReviewedExpense = inngest.createFunction(
  {
    id: 'complete-reviewed-expense',
    name: 'Complete Reviewed Expense',
  },
  { event: 'review/item.resolved' },
  async ({ event, step, logger }) => {
    const { reviewItemId, expenseId, categoryId, resolution } = event.data;

    logger.info(`Starting review completion`, { reviewItemId, expenseId });

    // Step 1: Fetch review item and expense
    const { reviewItem, expense } = await step.run('fetch-data', async () => {
      const item = await getReviewQueueItem(reviewItemId);
      if (!item) {
        throw new Error(`Review item ${reviewItemId} not found`);
      }

      const exp = await getExpense(item.runId, expenseId);
      if (!exp) {
        throw new Error(`Expense ${expenseId} not found`);
      }

      logger.debug(`Fetched review item and expense`, {
        reviewItemId,
        expenseId,
        runId: item.runId
      });

      return { reviewItem: item, expense: exp };
    });

    // Step 2: Handle different resolution types
    await step.run('save-resolution', async () => {
      if (resolution?.type === 'split') {
        // Expense was split into sub-expenses
        // Stats already updated by handler, just mark review item as resolved
        await resolveReviewQueueItem(reviewItemId);

        logger.info(`✓ Expense split handled`, {
          reviewItemId,
          expenseId,
          subExpenseCount: resolution.subExpenseIds?.length || 0
        });

      } else if (categoryId) {
        // Normal categorization or new category approved
        const now = new Date().toISOString();
        await saveCategorization({
          expenseId,
          categoryId,
          confidence: 1.0,
          reasoning: resolution?.reasoning || 'Manual categorization',
          amount: expense.amount,
          date: expense.date,
          description: expense.description,
          merchant: expense.merchant,
          createdAt: expense.date,
          categorizedAt: now,
          categorizationSource: 'manual',
        });

        await resolveReviewQueueItem(reviewItemId);

        // Update stats
        const run = await getWorkflowRun(reviewItem.runId);
        if (run) {
          await updateWorkflowRun(reviewItem.runId, {
            categorizedCount: run.categorizedCount + 1,
            reviewQueueCount: run.reviewQueueCount - 1,
          });
        }

        // Send tracking event for completion detection
        await inngest.send({
          name: 'expenses/expense.categorized' as const,
          data: {
            runId: reviewItem.runId,
            expenseId,
            categoryId,
            source: 'manual' as const,
          },
        });

        logger.info(`✓ Manual categorization saved`, {
          reviewItemId,
          expenseId,
          categoryId
        });
      }
    });

    return {
      expenseId,
      action: resolution?.type || 'categorized',
      categoryId,
    };
  }
);

