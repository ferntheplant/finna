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
    reviewItemId: string;
    expenseId: string;
    categoryId: string;
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
  ExpenseProcessingCompleted
>();
