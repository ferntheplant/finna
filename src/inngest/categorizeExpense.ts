import { inngest } from './client';
import type { Logger } from 'inngest';
import {
  getExpense,
  getAllCategories,
  saveCategorization,
  addToReviewQueue,
  updateWorkflowRun,
  getWorkflowRun,
} from '../db-operations';
import { categorizeExpense as callLLM } from '../llm';
import type { ReviewQueueItem, CategorizationResponse, Category, Expense } from '../types';

const CONFIDENCE_THRESHOLD = 0.7;

export const categorizeExpense = inngest.createFunction(
  {
    id: 'categorize-expense',
    name: 'Categorize Single Expense',
    throttle: {
      limit: 5,
      period: '10s',
      key: 'event.data.runId',
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

    // Step 3: Call LLM to categorize
    const llmResponse = await step.run('llm-categorization', async () => {
      logger.debug(`Calling LLM for categorization`, { runId, expenseId });
      const response = await callLLM(expense, categories, logger);
      logger.debug(`LLM: ${response.action} (conf: ${response.confidence || 'N/A'})`, {
        runId,
        expenseId,
        action: response.action,
        confidence: response.confidence,
        categoryId: response.categoryId
      });
      return response;
    });

    // Step 4: Handle LLM response based on action type
    if (llmResponse.action === 'categorize' && llmResponse.categoryId && llmResponse.confidence) {
      if (llmResponse.confidence >= CONFIDENCE_THRESHOLD) {
        return await handleHighConfidenceCategorization(step, logger, runId, expenseId, llmResponse);
      } else {
        return await handleLowConfidenceCategorization(step, logger, runId, expenseId, llmResponse);
      }
    } else if (llmResponse.action === 'create_subcategory' && llmResponse.newCategory) {
      return await handleNewCategoryRequest(step, logger, runId, expenseId, llmResponse);
    } else {
      return await handleObfuscatedMerchant(step, logger, runId, expenseId, llmResponse);
    }
  }
);

// High confidence - save categorization directly
async function handleHighConfidenceCategorization(
  step: any,
  logger: Logger,
  runId: string,
  expenseId: string,
  llmResponse: CategorizationResponse
) {
  await step.run('save-categorization', async () => {
    await saveCategorization({
      expenseId,
      categoryId: llmResponse.categoryId!,
      confidence: llmResponse.confidence!,
      reasoning: llmResponse.reasoning,
      createdAt: new Date().toISOString(),
    });

    await updateRunStats(runId, 'categorizedCount', 1);

    logger.debug(`✓ Categorized (${llmResponse.confidence})`, {
      runId,
      expenseId,
      categoryId: llmResponse.categoryId,
      confidence: llmResponse.confidence
    });
  });

  return {
    expenseId,
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
  expenseId: string,
  llmResponse: CategorizationResponse
) {
  await step.run('add-to-review-low-confidence', async () => {
    logger.info(`→ Review queue: low confidence (${llmResponse.confidence})`, {
      runId,
      expenseId,
      confidence: llmResponse.confidence
    });

    const reviewItem: ReviewQueueItem = {
      id: `review_${expenseId}`,
      expenseId,
      runId,
      reason: 'low_confidence',
      llmSuggestion: {
        categoryId: llmResponse.categoryId,
        confidence: llmResponse.confidence,
        reasoning: llmResponse.reasoning,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    logger.debug(`Added to review queue`, { runId, expenseId });
  });

  return await waitForResolutionAndSave(
    step,
    logger,
    runId,
    expenseId,
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
  expenseId: string,
  llmResponse: CategorizationResponse
) {
  await step.run('add-to-review-new-category', async () => {
    logger.info(`→ Review queue: new category "${llmResponse.newCategory?.name}"`, {
      runId,
      expenseId
    });

    const reviewItem: ReviewQueueItem = {
      id: `review_${expenseId}`,
      expenseId,
      runId,
      reason: 'new_category_suggestion',
      llmSuggestion: {
        reasoning: llmResponse.reasoning,
        newCategory: llmResponse.newCategory,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    logger.debug(`Added new category suggestion to review queue`, { runId, expenseId });
  });

  return await waitForResolutionAndSave(
    step,
    logger,
    runId,
    expenseId,
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
  expenseId: string,
  llmResponse: CategorizationResponse
) {
  await step.run('add-to-review-human-needed', async () => {
    logger.info(`→ Review queue: ${llmResponse.reasoning}`, {
      runId,
      expenseId
    });

    const reviewItem: ReviewQueueItem = {
      id: `review_${expenseId}`,
      expenseId,
      runId,
      reason: 'obfuscated_merchant',
      llmSuggestion: {
        reasoning: llmResponse.reasoning,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    logger.debug(`About to add review item:`, { reviewItem });
    await addToReviewQueue(reviewItem);
    await updateRunStats(runId, 'reviewQueueCount', 1);

    logger.debug(`Added to review queue - human needed`, { runId, expenseId });
  });

  return await waitForResolutionAndSave(
    step,
    logger,
    runId,
    expenseId,
    'wait-for-human-input',
    `Human clarification: ${llmResponse.reasoning}`,
    'human_clarified'
  );
}

// Common wait-for-resolution and save logic
async function waitForResolutionAndSave(
  step: any,
  logger: Logger,
  runId: string,
  expenseId: string,
  stepName: string,
  reasoning: string,
  actionName: string
) {
  logger.debug(`Waiting for human resolution`, { runId, expenseId });

  const resolution = await step.waitForEvent(stepName, {
    event: 'review/item.resolved',
    timeout: '7d',
    match: 'data.expenseId',
  });

  if (resolution) {
    await step.run(`save-${stepName}`, async () => {
      logger.debug(`Human resolution received, saving categorization`, {
        runId,
        expenseId,
        categoryId: resolution.data.categoryId
      });

      await saveCategorization({
        expenseId,
        categoryId: resolution.data.categoryId,
        confidence: 1.0,
        reasoning,
        createdAt: new Date().toISOString(),
      });

      // Update stats: increment categorized, decrement review queue
      const run = await getWorkflowRun(runId);
      if (run) {
        await updateWorkflowRun(runId, {
          categorizedCount: run.categorizedCount + 1,
          reviewQueueCount: run.reviewQueueCount - 1,
        });
      }

      logger.info(`✓ Human resolution complete`, { runId, expenseId });
    });

    return {
      expenseId,
      action: actionName,
      categoryId: resolution.data.categoryId
    };
  } else {
    logger.warn(`Resolution timeout - no human response received`, { runId, expenseId });
    return { expenseId, action: 'timeout' };
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
