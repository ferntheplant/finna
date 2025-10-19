import { inngest } from './client';
import type { Logger } from 'inngest';
import {
  getExpense,
  getAllCategories,
  saveCategorization,
  addToReviewQueue,
  updateWorkflowRun,
  getWorkflowRun,
  getSimilarCategorizedExpenses,
  getCategorization,
} from '../db-operations';
import { categorizeExpense as callLLM } from '../llm';
import type { ReviewQueueItem, CategorizationResponse, Category, Expense } from '../types';

const CONFIDENCE_THRESHOLD = 0.7;

export const categorizeExpense = inngest.createFunction(
  {
    id: 'categorize-expense',
    name: 'Categorize Single Expense',
    // Conservative throttling for local LLM hardware
    throttle: {
      limit: 2,  // Only 2 concurrent LLM calls per period
      period: '15s',  // Spread over 15 seconds
      key: 'event.data.runId',
    },
    // Generous retries with exponential backoff for LLM timeouts
    retries: 5,  // Retry up to 5 times
    // Handle LLM failure after all retries exhausted
    onFailure: async ({ event, error, step }) => {
      await step.run('handle-llm-failure', async () => {
        const { runId, expenseId } = event.data.event.data;

        // Add to review queue with special failure reason
        const reviewItem: ReviewQueueItem = {
          id: `review_${expenseId}`,
          expenseId,
          runId,
          reason: 'llm_failure',
          llmSuggestion: {
            reasoning: `LLM failed after 5 retries: ${error.message}`,
          },
          status: 'pending',
          createdAt: new Date().toISOString(),
          retryCount: 0,
          retryingAt: null,
        };

        await addToReviewQueue(reviewItem);

        // Update stats
        await updateRunStats(runId, 'reviewQueueCount', 1);
        await updateRunStats(runId, 'failedCount', 1);

        // Send tracking event
        await inngest.send({
          name: 'expenses/expense.failed' as const,
          data: { runId, expenseId, error: error.message },
        });
      });
    },
  },
  { event: 'expenses/categorize' },
  async ({ event, step, logger }) => {
    const { runId, expenseId } = event.data;

    logger.debug(`Starting categorization for expense`, { runId, expenseId });

    // Step 1: Fetch expense data
    const expense = await step.run('fetch-expense', async () => {
      logger.debug(`Fetching expense data`, { runId, expenseId });
      const exp = await getExpense(runId, expenseId);
      if (!exp) {
        logger.error(`Expense not found`, { runId, expenseId });
        throw new Error(`Expense ${expenseId} not found in run ${runId}`);
      }
      logger.debug(`Expense fetched: ${exp.description} ($${exp.amount})`, {
        runId,
        expenseId
      });
      return exp;
    });

    // Step 2: Fetch current categories
    const categories = await step.run('fetch-categories', async () => {
      logger.debug(`Fetching categories`, { runId, expenseId });
      const cats = await getAllCategories();
      logger.debug(`Fetched ${cats.length} categories`, { runId, expenseId });
      return cats;
    });

    // Step 3: Find similar already-categorized expenses
    const similarExpenses = await step.run('fetch-similar-expenses', async () => {
      logger.debug(`Finding similar categorized expenses`, { runId, expenseId });
      const similar = await getSimilarCategorizedExpenses(
        expense.merchant,
        expense.description,
        5 // Top 5 most similar
      );
      logger.debug(`Found ${similar.length} similar expenses`, {
        runId,
        expenseId,
        similarCount: similar.length
      });
      return similar;
    });

    // Step 3.5: Check if expense already has a categorization with annotation
    const existingCategorization = await step.run('check-existing-categorization', async () => {
      const existing = await getCategorization(expenseId);
      if (existing?.annotation) {
        logger.debug(`Found existing annotation for expense`, { runId, expenseId, annotation: existing.annotation });
      }
      return existing;
    });

    // Step 4: Call LLM to categorize
    // Function-level retries (5x with backoff) will handle timeouts
    const llmResponse = await step.run('llm-categorization', async () => {
      logger.debug(`Calling LLM for categorization`, { runId, expenseId });
      const response = await callLLM(
        expense,
        categories,
        logger,
        similarExpenses,
        existingCategorization?.annotation
      );
      logger.debug(`LLM: ${response.action} (conf: ${response.confidence || 'N/A'})`, {
        runId,
        expenseId,
        action: response.action,
        confidence: response.confidence,
        categoryId: response.categoryId
      });
      return response;
    });

    // Step 5: Handle LLM response based on action type
    if (llmResponse.action === 'categorize' && llmResponse.categoryId && llmResponse.confidence) {
      if (llmResponse.confidence >= CONFIDENCE_THRESHOLD) {
        return await handleHighConfidenceCategorization(step, logger, runId, expense, llmResponse);
      } else {
        return await handleLowConfidenceCategorization(step, logger, runId, expense, llmResponse);
      }
    } else if (llmResponse.action === 'create_subcategory' && llmResponse.newCategory) {
      return await handleNewCategoryRequest(step, logger, runId, expense, llmResponse);
    } else {
      return await handleObfuscatedMerchant(step, logger, runId, expense, llmResponse);
    }
  }
);

// High confidence - save categorization directly
async function handleHighConfidenceCategorization(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  return await step.run('save-categorization', async () => {
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
      categorizationSource: 'auto',
    });

    await updateRunStats(runId, 'categorizedCount', 1);

    // Send tracking event for completion detection
    await inngest.send({
      name: 'expenses/expense.categorized' as const,
      data: {
        runId,
        expenseId: expense.id,
        categoryId: llmResponse.categoryId!,
        source: 'auto' as const,
      },
    });

    logger.info(`✓ Categorized (${llmResponse.confidence})`, {
      runId,
      expenseId: expense.id,
      categoryId: llmResponse.categoryId,
      confidence: llmResponse.confidence
    });

    return {
      expenseId: expense.id,
      action: 'categorized',
      categoryId: llmResponse.categoryId,
      confidence: llmResponse.confidence,
    };
  });
}

// Low confidence - add to review queue and complete
async function handleLowConfidenceCategorization(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  return await step.run('add-to-review-low-confidence', async () => {
    logger.info(`→ Review queue: low confidence (${llmResponse.confidence})`, {
      runId,
      expenseId: expense.id,
      confidence: llmResponse.confidence
    });

    const reviewItem: ReviewQueueItem = {
      id: `review_${expense.id}`,
      expenseId: expense.id,
      runId,
      reason: 'low_confidence',
      llmSuggestion: {
        categoryId: llmResponse.categoryId,
        confidence: llmResponse.confidence,
        reasoning: llmResponse.reasoning,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      retryingAt: null,
    };

    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    // Send tracking event
    await inngest.send({
      name: 'expenses/expense.needs_review' as const,
      data: {
        runId,
        expenseId: expense.id,
        reason: 'low_confidence' as const,
      },
    });

    logger.info(`✓ Added to review queue`, { runId, expenseId: expense.id });

    // Workflow completes here - human will resolve later
    return {
      expenseId: expense.id,
      action: 'needs_review',
      reason: 'low_confidence',
    };
  });
}

// New category suggestion - add to review queue and complete
async function handleNewCategoryRequest(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  return await step.run('add-to-review-new-category', async () => {
    logger.info(`→ Review queue: new category "${llmResponse.newCategory?.name}"`, {
      runId,
      expenseId: expense.id
    });

    const reviewItem: ReviewQueueItem = {
      id: `review_${expense.id}`,
      expenseId: expense.id,
      runId,
      reason: 'new_category_suggestion',
      llmSuggestion: {
        reasoning: llmResponse.reasoning,
        newCategory: llmResponse.newCategory,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      retryingAt: null,
    };

    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    // Send tracking event
    await inngest.send({
      name: 'expenses/expense.needs_review' as const,
      data: {
        runId,
        expenseId: expense.id,
        reason: 'new_category_suggestion' as const,
      },
    });

    logger.info(`✓ Added new category suggestion to review queue`, { runId, expenseId: expense.id });

    // Workflow completes here - human will resolve later
    return {
      expenseId: expense.id,
      action: 'needs_review',
      reason: 'new_category_suggestion',
    };
  });
}

// Obfuscated merchant - needs human clarification
async function handleObfuscatedMerchant(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  return await step.run('add-to-review-human-needed', async () => {
    logger.info(`→ Review queue: ${llmResponse.reasoning}`, {
      runId,
      expenseId: expense.id
    });

    const reviewItem: ReviewQueueItem = {
      id: `review_${expense.id}`,
      expenseId: expense.id,
      runId,
      reason: 'obfuscated_merchant',
      llmSuggestion: {
        reasoning: llmResponse.reasoning,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      retryingAt: null,
    };

    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    // Send tracking event
    await inngest.send({
      name: 'expenses/expense.needs_review' as const,
      data: {
        runId,
        expenseId: expense.id,
        reason: 'obfuscated_merchant' as const,
      },
    });

    logger.info(`✓ Added to review queue - human needed`, { runId, expenseId: expense.id });

    // Workflow completes here - human will resolve later
    return {
      expenseId: expense.id,
      action: 'needs_review',
      reason: 'obfuscated_merchant',
    };
  });
}


// Helper to update run stats (without completion detection - handled by trackRunCompletion)
async function updateRunStats(
  runId: string,
  field: 'categorizedCount' | 'reviewQueueCount' | 'failedCount',
  increment: number
) {
  const run = await getWorkflowRun(runId);
  if (run) {
    const newValue = run[field] + increment;
    await updateWorkflowRun(runId, {
      [field]: newValue,
    });
  }
}
