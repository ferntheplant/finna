import { inngest } from './client';
import {
  getReviewQueue,
  getExpense,
  saveCategorization,
  resolveReviewQueueItem,
  getWorkflowRun,
  updateWorkflowRun,
  getAllCategories,
} from '../db-operations';
import { categorizeExpense as callLLM } from '../llm';
import { createLogger } from '../logger';

const logger = createLogger('inngest:retryPendingAfterCategoryCreation');

/**
 * When a new category is created, automatically retry pending review items
 * to see if they can now be categorized with the new category.
 *
 * This runs asynchronously after a category is created during manual review.
 */
export const retryPendingAfterCategoryCreation = inngest.createFunction(
  {
    id: 'retry-pending-after-category-creation',
    name: 'Retry Pending Reviews After Category Creation',
  },
  { event: 'category/created' },
  async ({ event, step }) => {
    const { categoryId } = event.data;

    logger.info({
      categoryId
    }, 'Category created - checking pending reviews');

    // Get all pending review items
    const pendingItems = await step.run('fetch-pending-reviews', async () => {
      const items = await getReviewQueue();

      // Filter for items that might be resolved by new categories
      return items.filter(item =>
        item.reason === 'new_category_suggestion' ||
        item.reason === 'duplicate_category_suggested'
      );
    });

    if (pendingItems.length === 0) {
      logger.debug('No pending review items to retry after category creation');
      return { retriedCount: 0, resolvedCount: 0 };
    }

    logger.info({
      itemCount: pendingItems.length
    }, 'Found pending items to retry');

    // Get updated categories list
    const categories = await step.run('fetch-categories', async () => {
      return await getAllCategories();
    });

    let resolvedCount = 0;

    // Retry each item
    for (const item of pendingItems) {
      await step.run(`retry-item-${item.id}`, async () => {
        try {
          const expense = await getExpense(item.runId, item.expenseId);
          if (!expense) {
            logger.warn({ expenseId: item.expenseId }, 'Expense not found for retry');
            return;
          }

          // Re-run LLM categorization with updated categories
          const llmResponse = await callLLM(expense, categories, logger);

          // If LLM now categorizes with high confidence, auto-resolve
          if (llmResponse.action === 'categorize' &&
              llmResponse.categoryId &&
              llmResponse.confidence &&
              llmResponse.confidence >= 0.7) {

            // Save the categorization
            const now = new Date().toISOString();
            await saveCategorization({
              expenseId: expense.id,
              categoryId: llmResponse.categoryId,
              confidence: llmResponse.confidence,
              reasoning: `Auto-resolved after new category creation: ${llmResponse.reasoning}`,
              amount: expense.amount,
              date: expense.date,
              description: expense.description,
              merchant: expense.merchant,
              createdAt: expense.date,
              categorizedAt: now,
              categorizationSource: 'retry_auto',
            });

            // Resolve the review item
            await resolveReviewQueueItem(item.id);

            // Update workflow stats
            const run = await getWorkflowRun(item.runId);
            if (run) {
              await updateWorkflowRun(item.runId, {
                categorizedCount: run.categorizedCount + 1,
                reviewQueueCount: run.reviewQueueCount - 1,
              });
            }

            // Send event
            await inngest.send({
              name: "review/item.resolved",
              data: {
                reviewItemId: item.id,
                expenseId: item.expenseId,
                categoryId: llmResponse.categoryId,
                autoResolved: true,
              },
            });

            resolvedCount++;

            logger.info({
              expenseId: expense.id,
              categoryId: llmResponse.categoryId,
              confidence: llmResponse.confidence
            }, 'Auto-resolved pending review item with new category');
          } else {
            logger.debug({
              expenseId: expense.id,
              action: llmResponse.action,
              confidence: llmResponse.confidence
            }, 'LLM still needs review after new category');
          }
        } catch (error) {
          logger.error({
            itemId: item.id,
            error: error instanceof Error ? error.message : String(error)
          }, 'Error retrying review item after new category');
          // Continue with other items
        }
      });
    }

    logger.info({
      retriedCount: pendingItems.length,
      resolvedCount
    }, 'Completed retry after category creation');

    return {
      retriedCount: pendingItems.length,
      resolvedCount
    };
  }
);

