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

    // Step 4: Call LLM to categorize
    // Function-level retries (5x with backoff) will handle timeouts
    const llmResponse = await step.run('llm-categorization', async () => {
      logger.debug(`Calling LLM for categorization`, { runId, expenseId });
      const response = await callLLM(expense, categories, logger, similarExpenses);
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
  await step.run('save-categorization', async () => {
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

    await updateRunStats(runId, 'categorizedCount', 1);

    logger.debug(`✓ Categorized (${llmResponse.confidence})`, {
      runId,
      expenseId: expense.id,
      categoryId: llmResponse.categoryId,
      confidence: llmResponse.confidence
    });
  });

  return {
    expenseId: expense.id,
    action: 'categorized',
    categoryId: llmResponse.categoryId,
    confidence: llmResponse.confidence,
  };
}

// Low confidence - add to review queue and wait for human input
async function handleLowConfidenceCategorization(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  await step.run('add-to-review-low-confidence', async () => {
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

    logger.debug(`Added to review queue`, { runId, expenseId: expense.id });
  });

  return await waitForResolutionAndSave(
    step,
    logger,
    runId,
    expense,
    'wait-for-review',
    `Human review resolved: ${llmResponse.reasoning}`,
    'human_reviewed'
  );
}

// New category suggestion - add to review queue for approval
async function handleNewCategoryRequest(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  await step.run('add-to-review-new-category', async () => {
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

    logger.debug(`Added new category suggestion to review queue`, { runId, expenseId: expense.id });
  });

  return await waitForResolutionAndSave(
    step,
    logger,
    runId,
    expense,
    'wait-for-category-approval',
    `New category approved: ${llmResponse.reasoning}`,
    'new_category_approved'
  );
}

// Obfuscated merchant - needs human clarification
async function handleObfuscatedMerchant(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  llmResponse: CategorizationResponse
) {
  await step.run('add-to-review-human-needed', async () => {
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

    logger.debug(`About to add review item:`, { reviewItem });
    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    logger.debug(`Added to review queue - human needed`, { runId, expenseId: expense.id });
  });

  return await waitForResolutionAndSave(
    step,
    logger,
    runId,
    expense,
    'wait-for-human-input',
    `Human clarification: ${llmResponse.reasoning}`,
    'human_clarified'
  );
}

// Common wait-for-resolution and save logic
// Note: Retries are handled by a separate workflow (retryReviewCategorization)
// which updates the suggestion in the review queue. This workflow just waits
// for the final human decision.
async function waitForResolutionAndSave(
  step: any,
  logger: Logger,
  runId: string,
  expense: Expense,
  stepName: string,
  reasoning: string,
  actionName: string
) {
  logger.debug(`Waiting for human resolution`, { runId, expenseId: expense.id });

  const resolution = await step.waitForEvent(stepName, {
    event: 'review/item.resolved',
    timeout: '7d',
    match: 'data.expenseId',
  });

  if (resolution) {
    await step.run(`save-${stepName}`, async () => {
      logger.debug(`Human resolution received`, {
        runId,
        expenseId: expense.id,
        categoryId: resolution.data.categoryId,
        wasSplit: resolution.data.wasSplit,
        alreadySaved: resolution.data.alreadySaved
      });

      // If the expense was split into sub-expenses, don't save a categorization for the parent
      // The stats were already updated in the handler, and sub-expenses will be categorized separately
      if (resolution.data.wasSplit || resolution.data.categoryId === "SPLIT") {
        logger.info(`✓ Expense split into sub-expenses`, {
          runId,
          expenseId: expense.id,
          subExpenseCount: resolution.data.subExpenseIds?.length || 0
        });
        return;
      }

      // If auto-resolved by high confidence retry, categorization is already saved
      // The retry workflow already saved it and updated stats
      if (resolution.data.alreadySaved) {
        logger.info(`✓ Auto-resolved by high confidence retry (already saved)`, {
          runId,
          expenseId: expense.id,
          categoryId: resolution.data.categoryId
        });
        return;
      }

      // Normal categorization case - save from human decision
      logger.debug(`Saving categorization from human decision`, {
        runId,
        expenseId: expense.id,
        categoryId: resolution.data.categoryId
      });

      const now = new Date().toISOString();
      await saveCategorization({
        expenseId: expense.id,
        categoryId: resolution.data.categoryId,
        confidence: 1.0,
        reasoning,
        amount: expense.amount,
        date: expense.date,
        description: expense.description,
        merchant: expense.merchant,
        createdAt: expense.date,
        categorizedAt: now,
      });

      // Update stats: increment categorized, decrement review queue
      const run = await getWorkflowRun(runId);
      if (run) {
        await updateWorkflowRun(runId, {
          categorizedCount: run.categorizedCount + 1,
          reviewQueueCount: run.reviewQueueCount - 1,
        });
      }

      logger.info(`✓ Human resolution complete`, { runId, expenseId: expense.id });
    });

    return {
      expenseId: expense.id,
      action: resolution.data.wasSplit ? 'split' :
              resolution.data.alreadySaved ? 'auto_resolved' :
              actionName,
      categoryId: resolution.data.categoryId
    };
  } else {
    logger.warn(`Resolution timeout - no human response received`, { runId, expenseId: expense.id });
    return { expenseId: expense.id, action: 'timeout' };
  }
}

// Helper to update run stats and check for completion
async function updateRunStats(runId: string, field: 'categorizedCount' | 'reviewQueueCount', increment: number) {
  const run = await getWorkflowRun(runId);
  if (run) {
    const newValue = run[field] + increment;
    await updateWorkflowRun(runId, {
      [field]: newValue,
    });

    // Check if all categorizations are complete
    // (categorized + review queue should equal total expenses)
    const categorizedCount = field === 'categorizedCount' ? newValue : run.categorizedCount;
    const reviewQueueCount = field === 'reviewQueueCount' ? newValue : run.reviewQueueCount;
    const processedCount = categorizedCount + reviewQueueCount;

    if (processedCount === run.totalExpenses) {
      // All categorizations are done! Send completion event
      await inngest.send({
        name: 'expenses/processing.completed',
        data: {
          runId,
          totalExpenses: run.totalExpenses,
          categorizedCount,
          reviewQueueCount,
        },
      });
    }
  }
}
