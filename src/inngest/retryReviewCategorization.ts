import { inngest } from './client';
import {
  getReviewQueueItem,
  getExpense,
  getAllCategories,
  updateReviewQueueItemSuggestion,
  markRetryInProgress,
  getSimilarCategorizedExpenses,
  saveCategorization,
  resolveReviewQueueItem,
  getWorkflowRun,
  updateWorkflowRun,
} from '../db-operations';
import { categorizeExpense as callLLM } from '../llm';

export const retryReviewCategorization = inngest.createFunction(
  {
    id: 'retry-review-categorization',
    name: 'Retry LLM Categorization for Review Item',
    // Same conservative throttling as initial categorization
    throttle: {
      limit: 2,  // Only 2 concurrent retries
      period: '15s',  // Per 15 seconds
      // No key = global throttling across all retries (even from different runs)
    },
    // Generous retries for local LLM
    retries: 5,
  },
  { event: 'review/retry.requested' },
  async ({ event, step, logger }) => {
    const { reviewItemId } = event.data;

    logger.info(`Starting retry for review item`, { reviewItemId });

    // Step 1: Mark retry as in progress (for UI status)
    await step.run('mark-retry-in-progress', async () => {
      await markRetryInProgress(reviewItemId);
      logger.debug(`Marked retry as in progress`, { reviewItemId });
    });

    // Step 2: Fetch review item
    const item = await step.run('fetch-review-item', async () => {
      const reviewItem = await getReviewQueueItem(reviewItemId);
      if (!reviewItem) {
        throw new Error(`Review item ${reviewItemId} not found`);
      }
      logger.debug(`Fetched review item for expense ${reviewItem.expenseId}`, {
        reviewItemId,
        expenseId: reviewItem.expenseId
      });
      return reviewItem;
    });

    // Step 3: Fetch expense data
    const expense = await step.run('fetch-expense', async () => {
      const exp = await getExpense(item.runId, item.expenseId);
      if (!exp) {
        throw new Error(`Expense ${item.expenseId} not found`);
      }
      logger.debug(`Fetched expense: ${exp.description} ($${exp.amount})`, {
        reviewItemId,
        expenseId: item.expenseId
      });
      return exp;
    });

    // Step 4: Fetch fresh categories (including any created since original attempt)
    const categories = await step.run('fetch-fresh-categories', async () => {
      const cats = await getAllCategories();
      logger.info(`Fetched ${cats.length} categories for retry`, {
        reviewItemId,
        categoryCount: cats.length
      });
      return cats;
    });

    // Step 5: Find similar already-categorized expenses
    const similarExpenses = await step.run('fetch-similar-expenses', async () => {
      logger.debug(`Finding similar categorized expenses for retry`, { reviewItemId });
      const similar = await getSimilarCategorizedExpenses(
        expense.merchant,
        expense.description,
        5 // Top 5 most similar
      );
      logger.info(`Found ${similar.length} similar expenses for retry`, {
        reviewItemId,
        similarCount: similar.length
      });
      return similar;
    });

    // Step 6: Call LLM to re-categorize with fresh category list and similar examples
    // Function-level retries (5x with backoff) will handle timeouts
    const llmResponse = await step.run('llm-retry-categorization', async () => {
      logger.debug(`Calling LLM for retry categorization`, { reviewItemId });
      const response = await callLLM(expense, categories, logger, similarExpenses);
      logger.info(`LLM retry: ${response.action} (conf: ${response.confidence || 'N/A'})`, {
        reviewItemId,
        action: response.action,
        confidence: response.confidence,
        categoryId: response.categoryId
      });
      return response;
    });

    // Step 7: Handle high confidence vs low confidence retries
    const CONFIDENCE_THRESHOLD = 0.7;
    const isHighConfidence = llmResponse.action === 'categorize' &&
                              llmResponse.categoryId &&
                              llmResponse.confidence &&
                              llmResponse.confidence >= CONFIDENCE_THRESHOLD;

    if (isHighConfidence) {
      // High confidence retry - auto-resolve and save categorization
      await step.run('auto-resolve-high-confidence', async () => {
        logger.info(`✓ High confidence retry (${llmResponse.confidence}) - auto-resolving`, {
          reviewItemId,
          categoryId: llmResponse.categoryId,
          confidence: llmResponse.confidence
        });

        // Save the categorization
        const now = new Date().toISOString();
        await saveCategorization({
          expenseId: expense.id,
          categoryId: llmResponse.categoryId!,
          confidence: llmResponse.confidence!,
          reasoning: llmResponse.reasoning,
          amount: expense.amount,
          date: expense.date,
          description: expense.description,
          merchant: expense.merchant,
          createdAt: expense.date,
          categorizedAt: now,
        });

        // Resolve the review item
        await resolveReviewQueueItem(reviewItemId);

        // Update stats: increment categorized, decrement review queue
        const run = await getWorkflowRun(item.runId);
        if (run) {
          await updateWorkflowRun(item.runId, {
            categorizedCount: run.categorizedCount + 1,
            reviewQueueCount: run.reviewQueueCount - 1,
          });
        }

        // CRITICAL: Send review/item.resolved event to unblock the waiting categorizeExpense workflow
        // The original workflow is stuck at step.waitForEvent() and needs this event to complete
        // Set alreadySaved=true so the workflow knows not to save again
        await inngest.send({
          name: 'review/item.resolved',
          data: {
            reviewItemId,
            expenseId: expense.id,
            categoryId: llmResponse.categoryId!,
            alreadySaved: true,  // Signal that categorization is already saved
          },
        });

        logger.info(`✓ Auto-resolved high confidence retry and sent completion event`, {
          reviewItemId,
          expenseId: expense.id,
          categoryId: llmResponse.categoryId
        });
      });

      return {
        reviewItemId,
        expenseId: item.expenseId,
        action: 'auto_resolved',
        categoryId: llmResponse.categoryId,
        confidence: llmResponse.confidence,
      };
    } else {
      // Low confidence or needs review - update suggestion for human review
      await step.run('update-review-suggestion', async () => {
        const suggestion: {
          categoryId?: string;
          confidence?: number;
          reasoning: string;
          newCategory?: {
            name: string;
            description: string;
            parentId?: string;
          };
        } = {
          reasoning: llmResponse.reasoning,
        };

        if (llmResponse.action === 'categorize' && llmResponse.categoryId && llmResponse.confidence) {
          suggestion.categoryId = llmResponse.categoryId;
          suggestion.confidence = llmResponse.confidence;
        } else if (llmResponse.action === 'create_subcategory' && llmResponse.newCategory) {
          suggestion.newCategory = llmResponse.newCategory;
        }

        await updateReviewQueueItemSuggestion(reviewItemId, suggestion);

        logger.info(`✓ Updated review item with new suggestion (user can now accept or retry again)`, {
          reviewItemId,
          action: llmResponse.action,
          confidence: llmResponse.confidence
        });
      });
    }

    // Step 8: Send notification event (for UI to reload the review item) - only for low confidence
    if (!isHighConfidence) {
      await step.run('notify-suggestion-updated', async () => {
        await inngest.send({
          name: 'review/suggestion.updated',
          data: {
            reviewItemId,
            expenseId: item.expenseId,
            runId: item.runId,
            suggestion: llmResponse,
          },
        });
      });

      return {
        reviewItemId,
        expenseId: item.expenseId,
        action: 'retry_complete',
        newSuggestion: llmResponse,
      };
    }

    // High confidence case already returned above
  }
);

