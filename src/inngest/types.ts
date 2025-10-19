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

type ReviewItemResolved = {
  name: "review/item.resolved";
  data: {
    reviewItemId?: string; // Optional for auto-resolved retries
    expenseId: string;
    categoryId: string;
    wasSplit?: boolean; // Optional flag when expense was split
    subExpenseIds?: string[]; // Optional list of sub-expense IDs
    alreadySaved?: boolean; // Optional flag when categorization already saved (auto-resolved retries)
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
  ReviewItemResolved |
  ReviewRetryRequested |
  ReviewSuggestionUpdated |
  ExpenseProcessingCompleted
>();
