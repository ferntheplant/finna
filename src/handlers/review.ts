import {
  getReviewQueue,
  getReviewQueueItem,
  resolveReviewQueueItem,
  getExpense,
  saveCategorization,
  createCategory,
  findCategoryByNameAndParent,
  createSubExpenses,
  validateSubExpenseSums,
  getWorkflowRun,
  updateWorkflowRun,
} from '../db-operations';
import { inngest } from '../inngest';
import { createLogger } from '../logger';

const logger = createLogger('handlers:review');

// Helper to safely serialize responses with BigInt values
function safeJsonStringify(data: any): string {
  return JSON.stringify(data, (key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  );
}

export async function handleGetReviewQueue(runId?: string): Promise<Response> {
  const queue = await getReviewQueue(runId);

  // Fetch expense details for each item
  const queueWithExpenses = await Promise.all(
    queue.map(async (item) => {
      const expense = await getExpense(item.runId, item.expenseId);
      return {
        ...item,
        expense,
      };
    })
  );

  return new Response(safeJsonStringify(queueWithExpenses), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetReviewItem(id: string): Promise<Response> {
  const item = await getReviewQueueItem(id);

  if (!item) {
    return new Response(safeJsonStringify({ error: "Review item not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fetch expense details
  const expense = await getExpense(item.runId, item.expenseId);

  return new Response(safeJsonStringify({ ...item, expense }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleCategorizeReview(id: string, request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const {
      categoryId,
      createNewCategory: newCategory,
      splitTransaction,
      amazonItems,
      amazonChargeSummary,
      amazonOrderDetails
    } = body;

    if (!categoryId && !newCategory && !splitTransaction && !amazonItems && !amazonOrderDetails) {
      return new Response(safeJsonStringify({
        error: "categoryId, createNewCategory, splitTransaction, amazonItems, or amazonOrderDetails required"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const item = await getReviewQueueItem(id);
    if (!item) {
      return new Response(safeJsonStringify({ error: "Review item not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const expense = await getExpense(item.runId, item.expenseId);
    if (!expense) {
      return new Response(safeJsonStringify({ error: "Expense not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle transaction splitting (manual or Amazon items)
    if (splitTransaction || amazonItems || amazonOrderDetails) {
      return await handleTransactionSplit(id, item, expense, splitTransaction, amazonItems, amazonChargeSummary, amazonOrderDetails);
    }

    // Handle normal categorization (no split)
    return await handleNormalCategorization(id, item, categoryId, newCategory);
  } catch (error) {
    return new Response(safeJsonStringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleTransactionSplit(
  reviewId: string,
  item: any,
  expense: any,
  splitTransaction: any,
  amazonItems: any,
  amazonChargeSummary: any,
  amazonOrderDetails: any
): Promise<Response> {
  let subExpenseSplits: Array<{ description: string; amount: number; merchant?: string }> = [];

  // Handle new format (single object with items and summary)
  if (amazonOrderDetails) {
    subExpenseSplits = parseAmazonItems(amazonOrderDetails.items, amazonOrderDetails.summary);
  }
  // Handle legacy format (separate items and summary)
  else if (amazonItems) {
    subExpenseSplits = parseAmazonItems(amazonItems, amazonChargeSummary);
  }
  // Handle manual split
  else if (splitTransaction) {
    subExpenseSplits = splitTransaction;
  }

  // Validate amounts sum to parent
  try {
    validateSubExpenseSums(
      expense.amount,
      subExpenseSplits.map(s => s.amount)
    );
  } catch (validationError) {
    return new Response(safeJsonStringify({
      error: validationError instanceof Error ? validationError.message : "Validation failed"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create sub-expenses
  const subExpenseIds = await createSubExpenses(expense, subExpenseSplits);

  // Resolve review item
  await resolveReviewQueueItem(reviewId);

  // Update workflow stats: decrement review queue count
  // Note: We don't increment categorizedCount because the parent expense is being split, not categorized
  // The sub-expenses will be categorized separately and will update stats on their own
  const run = await getWorkflowRun(item.runId);
  if (run) {
    await updateWorkflowRun(item.runId, {
      reviewQueueCount: run.reviewQueueCount - 1,
    });

    logger.info({
      runId: item.runId,
      expenseId: item.expenseId,
      subExpenseCount: subExpenseIds.length,
      newReviewQueueCount: run.reviewQueueCount - 1,
    }, 'Split transaction resolved, updated workflow stats');
  }

  // Send event to unblock any workflow waiting for this review item
  // Use a special categoryId to indicate this was split, not categorized
  await inngest.send({
    name: "review/item.resolved",
    data: {
      reviewItemId: reviewId,
      expenseId: item.expenseId,
      categoryId: "SPLIT", // Special marker indicating this expense was split into sub-expenses
      wasSplit: true,
      subExpenseIds: subExpenseIds,
    },
  });

  // Trigger categorization for each sub-expense
  const categorizationEvents = subExpenseIds.map(subExpenseId => ({
    name: 'expenses/categorize' as const,
    data: {
      runId: item.runId,
      expenseId: subExpenseId,
    },
  }));

  await inngest.send(categorizationEvents);

  return new Response(safeJsonStringify({
    message: "Transaction split into sub-expenses",
    subExpenseIds,
    subExpenseCount: subExpenseIds.length,
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleNormalCategorization(
  reviewId: string,
  item: any,
  categoryId: string | undefined,
  newCategory: any
): Promise<Response> {
  // If creating a new category, check if it already exists first
  let finalCategoryId = categoryId;
  if (newCategory) {
    const { name, description, parentId } = newCategory;

    // Check if a category with the same name and parent already exists (case-insensitive)
    const existingCategory = await findCategoryByNameAndParent(name, parentId);

    if (existingCategory) {
      // Use the existing category instead of creating a duplicate
      finalCategoryId = existingCategory.id;
      logger.info({
        name,
        parentId,
        existingCategoryId: existingCategory.id
      }, 'Using existing category instead of creating duplicate');
    } else {
      // Create the new category
      finalCategoryId = `cat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      await createCategory({ id: finalCategoryId, name, description, parentId });
      logger.info({
        name,
        parentId,
        newCategoryId: finalCategoryId
      }, 'Created new category');
    }
  }

  // Ensure we have a category ID
  if (!finalCategoryId) {
    return new Response(safeJsonStringify({
      error: "No category ID provided"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get expense to include its data in categorization
  const expense = await getExpense(item.runId, item.expenseId);
  if (!expense) {
    return new Response(safeJsonStringify({
      error: "Expense not found"
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Save categorization
  const now = new Date().toISOString();
  await saveCategorization({
    expenseId: item.expenseId,
    categoryId: finalCategoryId,
    confidence: 1.0,
    reasoning: "Human review",
    amount: expense.amount,
    date: expense.date,
    description: expense.description,
    merchant: expense.merchant,
    createdAt: expense.date,
    categorizedAt: now,
  });

  // Resolve review item
  await resolveReviewQueueItem(reviewId);

  // Send event to resume workflow
  await inngest.send({
    name: "review/item.resolved",
    data: {
      reviewItemId: reviewId,
      expenseId: item.expenseId,
      categoryId: finalCategoryId,
    },
  });

  return new Response(safeJsonStringify({
    message: "Review resolved",
    categoryId: finalCategoryId
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

function parseAmazonItems(amazonItems: any[], amazonChargeSummary: any): Array<{ description: string; amount: number; merchant?: string }> {
  const items = amazonItems.map((item: any) => ({
    description: item.itemTitle,
    amount: parseFloat(item.unitPrice.replace(/[$,]/g, '')),
    merchant: item.orderedMerchant,
  }));

  // If charge summary provided, calculate shipping/tax difference and add to most expensive item
  if (amazonChargeSummary && Array.isArray(amazonChargeSummary)) {
    const grandTotalItem = amazonChargeSummary.find((item: any) =>
      item.label && item.label.toLowerCase().includes('grand total')
    );

    if (grandTotalItem && grandTotalItem.content) {
      const grandTotal = parseFloat(grandTotalItem.content.replace(/[$,]/g, ''));
      const itemsTotal = items.reduce((sum: number, item: any) => sum + item.amount, 0);
      const difference = grandTotal - itemsTotal;

      // If there's a difference (shipping/taxes), add it to the most expensive item
      if (Math.abs(difference) > 0.01 && items.length > 0) {
        const mostExpensiveIndex = items.reduce((maxIdx: number, item: any, idx: number, arr: any[]) =>
          item.amount > arr[maxIdx].amount ? idx : maxIdx
        , 0);

        const mostExpensiveItem = items[mostExpensiveIndex];
        if (mostExpensiveItem) {
          mostExpensiveItem.amount += difference;

          logger.debug({
            grandTotal,
            itemsTotal,
            difference: difference.toFixed(2),
            adjustedItem: mostExpensiveItem.description.substring(0, 50) + '...',
            newAmount: mostExpensiveItem.amount.toFixed(2)
          }, 'Adjusted Amazon items for shipping/taxes');
        }
      }
    }
  }

  return items;
}

export async function handleRetryReview(id: string): Promise<Response> {
  try {
    // Verify the review item exists before triggering workflow
    const item = await getReviewQueueItem(id);
    if (!item) {
      return new Response(safeJsonStringify({ error: "Review item not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    logger.info({
      reviewId: id,
      expenseId: item.expenseId,
      runId: item.runId
    }, 'Triggering retry workflow');

    // Trigger the retry workflow - all logic happens there
    await inngest.send({
      name: "review/retry.requested",
      data: {
        reviewItemId: id,
      },
    });

    return new Response(safeJsonStringify({
      message: "Retry workflow triggered - the LLM will re-categorize with fresh categories",
      reviewItemId: id,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.error({
      reviewId: id,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to trigger retry workflow');

    return new Response(safeJsonStringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

