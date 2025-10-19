import {
  getReviewQueue,
  getReviewQueueItem,
  resolveReviewQueueItem,
  getExpense,
  saveCategorization,
  createCategory,
  createSubExpenses,
  validateSubExpenseSums,
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
      amazonChargeSummary
    } = body;

    if (!categoryId && !newCategory && !splitTransaction && !amazonItems) {
      return new Response(safeJsonStringify({
        error: "categoryId, createNewCategory, splitTransaction, or amazonItems required"
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
    if (splitTransaction || amazonItems) {
      return await handleTransactionSplit(id, item, expense, splitTransaction, amazonItems, amazonChargeSummary);
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
  amazonChargeSummary: any
): Promise<Response> {
  let subExpenseSplits: Array<{ description: string; amount: number; merchant?: string }> = [];

  if (amazonItems) {
    subExpenseSplits = parseAmazonItems(amazonItems, amazonChargeSummary);
  } else if (splitTransaction) {
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
  // If creating a new category, do that first
  let finalCategoryId = categoryId;
  if (newCategory) {
    const { name, description, parentId } = newCategory;
    finalCategoryId = `cat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await createCategory({ id: finalCategoryId, name, description, parentId });
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

  // Save categorization
  await saveCategorization({
    expenseId: item.expenseId,
    categoryId: finalCategoryId,
    confidence: 1.0,
    reasoning: "Human review",
    createdAt: new Date().toISOString(),
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

