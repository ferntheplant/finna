// Core expense type that normalizes both CSV formats
export type Expense = {
  id: string;
  runId: string;
  date: string; // ISO date string
  description: string;
  amount: number;
  merchant: string;
  source: 'credit_card' | 'bank_statement';
  parentExpenseId?: string | null; // If this is a sub-expense, reference to parent
  isSubExpense?: boolean; // Flag to indicate this is a split from a parent transaction
  rawData?: Record<string, any>; // Original CSV row data for reference
};

// Category structure
export type Category = {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
};

// Categorization result linking expense to category
// Includes denormalized expense data for easier analysis without joins
export type Categorization = {
  expenseId: string;
  categoryId: string;
  confidence: number; // 0-1
  reasoning: string;
  suggestedNewCategory?: {
    name: string;
    description: string;
    parentId: string;
  };
  amount: number;
  date: string; // ISO timestamp
  description: string;
  merchant: string;
  createdAt: string; // ISO timestamp - when the expense was created
  categorizedAt: string; // ISO timestamp - when this categorization was made
  annotation?: string; // Optional manual annotation added during review
  categorizationSource: 'auto' | 'manual' | 'retry_auto'; // How this was categorized
};

// Review queue item
export type ReviewQueueItem = {
  id: string;
  expenseId: string;
  runId: string;
  reason: 'low_confidence' | 'obfuscated_merchant' | 'new_category_suggestion' | 'llm_failure';
  llmSuggestion?: {
    categoryId?: string;
    confidence?: number;
    reasoning?: string;
    newCategory?: {
      name: string;
      description: string;
      parentId: string;
    };
  };
  status: 'pending' | 'resolved';
  createdAt: string;
  retryCount: number;
  retryingAt?: string | null;
};

// Sub-expense split for breaking up a transaction
export type SubExpenseSplit = {
  description: string;
  amount: number;
  merchant?: string; // Optional override for sub-expense merchant
};

// Amazon item data from parse-amazon.js
export type AmazonPurchaseItem = {
  itemTitle: string;
  orderedMerchant: string;
  unitPrice: string; // e.g., "$24.99"
};

// Amazon charge summary data from parse-amazon.js
export type AmazonChargeSummaryItem = {
  label: string; // e.g., "Grand Total:", "Shipping & Handling:"
  content: string; // e.g., "$159.60"
};

// Amazon order details - the new format returned by parse-amazon.js
export type AmazonOrderDetails = {
  items: AmazonPurchaseItem[];
  summary: AmazonChargeSummaryItem[];
};

// Workflow run metadata
export type WorkflowRun = {
  runId: string;
  filePath: string;
  csvType: 'credit_card' | 'bank_statement';
  status: 'processing' | 'categorization_done' | 'completed' | 'failed';
  totalExpenses: number;
  categorizedCount: number;
  reviewQueueCount: number;
  failedCount: number;
  startedAt: string;
  completedAt?: string;
};

// LLM categorization request
export type CategorizationRequest = {
  expense: Expense;
  categories: Category[];
};

// LLM categorization response
export type CategorizationResponse = {
  action: 'categorize' | 'create_subcategory' | 'needs_human_review';
  categoryId?: string;
  confidence?: number; // 0-1
  reasoning: string;
  newCategory?: {
    name: string;
    description: string;
    parentId: string;
  };
};

