import { EventSchemas } from "inngest";

type ExpenseProcessingStarted = {
  name: "expenses/processing.started";
  data: {
    runId: string;
    filePath: string;
    csvType: "credit_card" | "bank_statement";
  };
};

type ExpenseCategorize = {
  name: "expenses/categorize";
  data: {
    runId: string;
    expenseId: string;
  };
};

type ExpenseCategorizationComplete = {
  name: "expenses/categorization.complete";
  data: {
    runId: string;
    expenseId: string;
    categoryId: string;
  };
};

type ExpenseCategorized = {
  name: "expenses/expense.categorized";
  data: {
    runId: string;
    expenseId: string;
    categoryId: string;
    source: "auto" | "manual" | "retry_auto";
  };
};

type ExpenseNeedsReview = {
  name: "expenses/expense.needs_review";
  data: {
    runId: string;
    expenseId: string;
    reason: "low_confidence" | "obfuscated_merchant" | "new_category_suggestion";
  };
};

type ExpenseFailed = {
  name: "expenses/expense.failed";
  data: {
    runId: string;
    expenseId: string;
    error: string;
  };
};

type ReviewItemResolved = {
  name: "review/item.resolved";
  data: {
    reviewItemId: string;
    expenseId: string;
    categoryId: string;
    resolution?: {
      type?: "split" | "categorize";
      reasoning?: string;
      subExpenseIds?: string[];
    };
  };
};

type ReviewRetryRequested = {
  name: "review/retry.requested";
  data: {
    reviewItemId: string;
  };
};

type ReviewSuggestionUpdated = {
  name: "review/suggestion.updated";
  data: {
    reviewItemId: string;
    expenseId: string;
    runId: string;
    suggestion: {
      action: string;
      reasoning: string;
      categoryId?: string;
      confidence?: number;
      newCategory?: {
        name: string;
        description: string;
        parentId?: string;
      };
    };
  };
};

type ExpenseProcessingCompleted = {
  name: "expenses/processing.completed";
  data: {
    runId: string;
    totalExpenses: number;
    categorizedCount: number;
    reviewQueueCount: number;
  };
};

export const schemas = new EventSchemas().fromUnion<
  ExpenseProcessingStarted |
  ExpenseCategorize |
  ExpenseCategorizationComplete |
  ExpenseCategorized |
  ExpenseNeedsReview |
  ExpenseFailed |
  ReviewItemResolved |
  ReviewRetryRequested |
  ReviewSuggestionUpdated |
  ExpenseProcessingCompleted
>();
