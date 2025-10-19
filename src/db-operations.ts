import { conn } from "./db";
import type { Category, Expense, Categorization, ReviewQueueItem, WorkflowRun } from "./types";
import { ROOT_CATEGORIES } from "./categories";
import { createLogger } from './logger';

const logger = createLogger('db');

// Initialize all required tables
export async function initializeTables() {
  // Categories table
  await conn.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      description VARCHAR NOT NULL,
      parentId VARCHAR
    )
  `);

  // Seed with ROOT_CATEGORIES if table is empty
  const countReader = await conn.runAndReadAll("SELECT COUNT(*) as count FROM categories");
  const countValue = countReader.getRowObjectsJS()[0]?.count;
  if (countValue === 0 || countValue === 0n) {
    for (const category of ROOT_CATEGORIES) {
      await conn.run(
        "INSERT INTO categories (id, name, description, parentId) VALUES (?, ?, ?, ?)",
        [category.id, category.name, category.description, category.parentId]
      );
    }
  }

  // Categorizations table (links expenses to categories)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS categorizations (
      expenseId VARCHAR PRIMARY KEY,
      categoryId VARCHAR NOT NULL,
      confidence DOUBLE NOT NULL,
      reasoning VARCHAR NOT NULL,
      suggestedNewCategoryName VARCHAR,
      suggestedNewCategoryDescription VARCHAR,
      suggestedNewCategoryParentId VARCHAR,
      createdAt TIMESTAMP NOT NULL
    )
  `);

  // Review queue table
  await conn.run(`
    CREATE TABLE IF NOT EXISTS review_queue (
      id VARCHAR PRIMARY KEY,
      expenseId VARCHAR NOT NULL,
      runId VARCHAR NOT NULL,
      reason VARCHAR NOT NULL,
      llmSuggestionCategoryId VARCHAR,
      llmSuggestionConfidence DOUBLE,
      llmSuggestionReasoning VARCHAR,
      llmSuggestionNewCategoryName VARCHAR,
      llmSuggestionNewCategoryDescription VARCHAR,
      llmSuggestionNewCategoryParentId VARCHAR,
      status VARCHAR NOT NULL,
      createdAt TIMESTAMP NOT NULL
    )
  `);

  // Workflow runs table
  await conn.run(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      runId VARCHAR PRIMARY KEY,
      filePath VARCHAR NOT NULL,
      csvType VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      totalExpenses INTEGER NOT NULL,
      categorizedCount INTEGER NOT NULL,
      reviewQueueCount INTEGER NOT NULL,
      startedAt TIMESTAMP NOT NULL,
      completedAt TIMESTAMP
    )
  `);
}

// Create a table for a specific workflow run from CSV file
export async function ingestCreditCardCSV(filePath: string, runId: string): Promise<number> {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;

  // Use DuckDB's native CSV reader with column mapping
  // Keep all original CSV columns (*) but exclude ones we're normalizing
  // Generate stable IDs based on content hash so same expense always gets same ID
  // Filter out negative charges (bill payments)
  await conn.run(`
    CREATE TABLE ${tableName} AS
    SELECT
      * EXCLUDE (Date, Description, Amount, "Appears On Your Statement As"),
      'exp_' || md5(COALESCE(Date::VARCHAR, '') || COALESCE(Description, '') || COALESCE(CAST(Amount as VARCHAR), '') || COALESCE("Appears On Your Statement As", ''))::VARCHAR as id,
      '${runId}' as runId,
      strptime(Date::VARCHAR, '%Y-%m-%d') as date,
      Description as description,
      CAST(Amount as DOUBLE) as amount,
      "Appears On Your Statement As" as merchant,
      'credit_card' as source,
      NULL as parentExpenseId,
      false as isSubExpense,
      Date as rawDate,
      Description as rawDescription,
      Amount as rawAmount,
      "Appears On Your Statement As" as rawMerchant
    FROM read_csv('${filePath}',
      header=true,
      auto_detect=true,
      ignore_errors=true
    )
    WHERE CAST(Amount as DOUBLE) > 0
  `);

  // Count rows
  const reader = await conn.runAndReadAll(`SELECT COUNT(*) as count FROM ${tableName}`);
  const countValue = reader.getRowObjectsJS()[0]?.count;
  const count = typeof countValue === 'bigint' ? Number(countValue) : (typeof countValue === 'number' ? countValue : 0);
  return count;
}

export async function ingestBankStatementCSV(filePath: string, runId: string): Promise<number> {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;

  // Use DuckDB's native CSV reader with column mapping
  // Keep all original CSV columns (*) but exclude ones we're normalizing
  // Generate stable IDs based on content hash so same expense always gets same ID
  // Filter out negative charges (bill payments)
  await conn.run(`
    CREATE TABLE ${tableName} AS
    SELECT
      * EXCLUDE ("Posting Date", Description, Amount),
      'exp_' || md5(COALESCE("Posting Date"::VARCHAR, '') || COALESCE(Description, '') || COALESCE(CAST(Amount as VARCHAR), ''))::VARCHAR as id,
      '${runId}' as runId,
      strptime("Posting Date"::VARCHAR, '%Y-%m-%d') as date,
      Description as description,
      CAST(Amount as DOUBLE) as amount,
      Description as merchant,
      'bank_statement' as source,
      NULL as parentExpenseId,
      false as isSubExpense,
      "Posting Date" as rawPostingDate,
      Description as rawDescription,
      Amount as rawAmount
    FROM read_csv('${filePath}',
      header=true,
      auto_detect=true,
      ignore_errors=true
    )
    WHERE CAST(Amount as DOUBLE) > 0
  `);

  // Count rows
  const reader = await conn.runAndReadAll(`SELECT COUNT(*) as count FROM ${tableName}`);
  const countValue = reader.getRowObjectsJS()[0]?.count;
  const count = typeof countValue === 'bigint' ? Number(countValue) : (typeof countValue === 'number' ? countValue : 0);
  return count;
}

// Get all expenses for a run
export async function getExpenses(runId: string): Promise<Expense[]> {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;
  const reader = await conn.runAndReadAll(`SELECT * FROM ${tableName}`);

  // Our normalized fields that we extract (these get excluded from rawData)
  const normalizedFields = new Set(['id', 'runId', 'date', 'description', 'amount', 'merchant', 'source', 'parentExpenseId', 'isSubExpense']);

  return reader.getRowObjectsJS().map((row: any) => {
    // Build rawData from all non-normalized columns
    const rawData: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!normalizedFields.has(key) && value !== null && value !== undefined) {
        rawData[key] = value;
      }
    }

    return {
      id: row.id,
      runId: row.runId,
      date: row.date?.toISOString() || '',
      description: row.description || '',
      amount: row.amount || 0,
      merchant: row.merchant || '',
      source: row.source,
      parentExpenseId: row.parentExpenseId || null,
      isSubExpense: row.isSubExpense || false,
      rawData: Object.keys(rawData).length > 0 ? rawData : undefined,
    };
  });
}

// Get single expense
export async function getExpense(runId: string, expenseId: string): Promise<Expense | null> {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;
  const reader = await conn.runAndReadAll(
    `SELECT * FROM ${tableName} WHERE id = ?`,
    [expenseId]
  );
  const rows = reader.getRowObjectsJS();
  if (rows.length === 0) return null;

  const row: any = rows[0];

  // Our normalized fields that we extract (these get excluded from rawData)
  const normalizedFields = new Set(['id', 'runId', 'date', 'description', 'amount', 'merchant', 'source', 'parentExpenseId', 'isSubExpense']);

  // Build rawData from all non-normalized columns
  const rawData: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!normalizedFields.has(key) && value !== null && value !== undefined) {
      rawData[key] = value;
    }
  }

  return {
    id: row.id,
    runId: row.runId,
    date: row.date?.toISOString() || '',
    description: row.description || '',
    amount: row.amount || 0,
    merchant: row.merchant || '',
    source: row.source,
    parentExpenseId: row.parentExpenseId || null,
    isSubExpense: row.isSubExpense || false,
    rawData: Object.keys(rawData).length > 0 ? rawData : undefined,
  };
}

// Category operations
export async function getAllCategories(): Promise<Category[]> {
  const reader = await conn.runAndReadAll("SELECT * FROM categories ORDER BY id");
  return reader.getRowObjectsJS().map((row: any) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    parentId: row.parentId,
  }));
}

export async function createCategory(category: Category): Promise<void> {
  try {
    await conn.run(
      "INSERT INTO categories (id, name, description, parentId) VALUES (?, ?, ?, ?)",
      [category.id, category.name, category.description, category.parentId]
    );
  } catch (error) {
    logger.error({
      categoryId: category.id,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to create category');
    throw error;
  }
}

// Categorization operations
export async function saveCategorization(categorization: Categorization): Promise<void> {
  try {
    await conn.run(
      `INSERT OR REPLACE INTO categorizations
       (expenseId, categoryId, confidence, reasoning, suggestedNewCategoryName, suggestedNewCategoryDescription, suggestedNewCategoryParentId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        categorization.expenseId,
        categorization.categoryId,
        categorization.confidence,
        categorization.reasoning,
        categorization.suggestedNewCategory?.name || null,
        categorization.suggestedNewCategory?.description || null,
        categorization.suggestedNewCategory?.parentId || null,
        categorization.createdAt
      ]
    );
  } catch (error) {
    logger.error({
      expenseId: categorization.expenseId,
      categoryId: categorization.categoryId,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to save categorization');
    throw error;
  }
}

export async function getCategorization(expenseId: string): Promise<Categorization | null> {
  const reader = await conn.runAndReadAll(
    "SELECT * FROM categorizations WHERE expenseId = ?",
    [expenseId]
  );
  const rows = reader.getRowObjectsJS();
  if (rows.length === 0) return null;

  const row: any = rows[0];
  return {
    expenseId: row.expenseId,
    categoryId: row.categoryId,
    confidence: row.confidence,
    reasoning: row.reasoning,
    suggestedNewCategory: row.suggestedNewCategoryName ? {
      name: row.suggestedNewCategoryName,
      description: row.suggestedNewCategoryDescription,
      parentId: row.suggestedNewCategoryParentId,
    } : undefined,
    createdAt: row.createdAt,
  };
}

// Review queue operations
export async function addToReviewQueue(item: ReviewQueueItem): Promise<void> {
  try {
    // Validate ALL required fields
    if (!item.id) {
      throw new Error(`Missing id field`);
    }
    if (!item.expenseId) {
      throw new Error(`Missing expenseId field`);
    }
    if (!item.runId) {
      throw new Error(`Missing runId field`);
    }
    if (!item.reason) {
      throw new Error(`Missing reason field`);
    }
    if (!item.status) {
      throw new Error(`Missing status field`);
    }
    if (!item.createdAt) {
      throw new Error(`Missing createdAt field`);
    }

    // Log what we're about to insert for debugging
    logger.debug({
      id: item.id,
      expenseId: item.expenseId,
      runId: item.runId,
      reason: item.reason,
      status: item.status,
      createdAt: item.createdAt,
      hasSuggestion: !!item.llmSuggestion
    }, 'Adding to review queue');

    // Use INSERT OR IGNORE to gracefully handle duplicates
    await conn.run(
      `INSERT OR IGNORE INTO review_queue
       (id, expenseId, runId, reason, llmSuggestionCategoryId, llmSuggestionConfidence, llmSuggestionReasoning,
        llmSuggestionNewCategoryName, llmSuggestionNewCategoryDescription, llmSuggestionNewCategoryParentId, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.expenseId,
        item.runId,
        item.reason,
        item.llmSuggestion?.categoryId || null,
        item.llmSuggestion?.confidence || null,
        item.llmSuggestion?.reasoning || null,
        item.llmSuggestion?.newCategory?.name || null,
        item.llmSuggestion?.newCategory?.description || null,
        item.llmSuggestion?.newCategory?.parentId || null,
        item.status,
        item.createdAt
      ]
    );

    logger.debug({ itemId: item.id }, 'Successfully added to review queue (or already exists)');
  } catch (error) {
    // Even with INSERT OR IGNORE, log if there's an unexpected error
    logger.warn({
      itemId: item.id,
      expenseId: item.expenseId,
      error: error instanceof Error ? error.message : error,
    }, 'Issue adding to review queue (may be duplicate, continuing)');
    // Don't throw - duplicate review queue entries are not critical
  }
}

export async function getReviewQueue(runId?: string): Promise<ReviewQueueItem[]> {
  const query = runId
    ? "SELECT * FROM review_queue WHERE status = 'pending' AND runId = ? ORDER BY createdAt"
    : "SELECT * FROM review_queue WHERE status = 'pending' ORDER BY createdAt";

  const reader = runId
    ? await conn.runAndReadAll(query, [runId])
    : await conn.runAndReadAll(query);

  return reader.getRowObjectsJS().map((row: any) => ({
    id: row.id,
    expenseId: row.expenseId,
    runId: row.runId,
    reason: row.reason,
    llmSuggestion: row.llmSuggestionReasoning ? {
      categoryId: row.llmSuggestionCategoryId,
      confidence: row.llmSuggestionConfidence,
      reasoning: row.llmSuggestionReasoning,
      newCategory: row.llmSuggestionNewCategoryName ? {
        name: row.llmSuggestionNewCategoryName,
        description: row.llmSuggestionNewCategoryDescription,
        parentId: row.llmSuggestionNewCategoryParentId,
      } : undefined,
    } : undefined,
    status: row.status,
    createdAt: row.createdAt,
  }));
}

export async function getReviewQueueItem(id: string): Promise<ReviewQueueItem | null> {
  const reader = await conn.runAndReadAll("SELECT * FROM review_queue WHERE id = ?", [id]);
  const rows = reader.getRowObjectsJS();
  if (rows.length === 0) return null;

  const row: any = rows[0];
  return {
    id: row.id,
    expenseId: row.expenseId,
    runId: row.runId,
    reason: row.reason,
    llmSuggestion: row.llmSuggestionReasoning ? {
      categoryId: row.llmSuggestionCategoryId,
      confidence: row.llmSuggestionConfidence,
      reasoning: row.llmSuggestionReasoning,
      newCategory: row.llmSuggestionNewCategoryName ? {
        name: row.llmSuggestionNewCategoryName,
        description: row.llmSuggestionNewCategoryDescription,
        parentId: row.llmSuggestionNewCategoryParentId,
      } : undefined,
    } : undefined,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function resolveReviewQueueItem(id: string): Promise<void> {
  try {
    await conn.run(
      "UPDATE review_queue SET status = 'resolved' WHERE id = ?",
      [id]
    );
  } catch (error) {
    logger.error({
      itemId: id,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to resolve review queue item');
    throw error;
  }
}

// Workflow run operations
export async function createWorkflowRun(run: WorkflowRun): Promise<void> {
  try {
    await conn.run(
      `INSERT INTO workflow_runs
       (runId, filePath, csvType, status, totalExpenses, categorizedCount, reviewQueueCount, startedAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.runId,
        run.filePath,
        run.csvType,
        run.status,
        run.totalExpenses,
        run.categorizedCount,
        run.reviewQueueCount,
        run.startedAt,
        run.completedAt || null
      ]
    );
  } catch (error) {
    logger.error({
      runId: run.runId,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to create workflow run');
    throw error;
  }
}

export async function updateWorkflowRun(runId: string, updates: Partial<WorkflowRun>): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.categorizedCount !== undefined) {
    fields.push("categorizedCount = ?");
    values.push(updates.categorizedCount);
  }
  if (updates.reviewQueueCount !== undefined) {
    fields.push("reviewQueueCount = ?");
    values.push(updates.reviewQueueCount);
  }
  if (updates.completedAt !== undefined) {
    fields.push("completedAt = ?");
    values.push(updates.completedAt);
  }

  if (fields.length > 0) {
    values.push(runId);
    try {
      await conn.run(
        `UPDATE workflow_runs SET ${fields.join(", ")} WHERE runId = ?`,
        values
      );
    } catch (error) {
      logger.error({
        runId: runId,
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined
      }, 'Failed to update workflow run');
      throw error;
    }
  }
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRun | null> {
  const reader = await conn.runAndReadAll("SELECT * FROM workflow_runs WHERE runId = ?", [runId]);
  const rows = reader.getRowObjectsJS();
  if (rows.length === 0) return null;

  const row: any = rows[0];
  return {
    runId: row.runId,
    filePath: row.filePath,
    csvType: row.csvType,
    status: row.status,
    totalExpenses: row.totalExpenses,
    categorizedCount: row.categorizedCount,
    reviewQueueCount: row.reviewQueueCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export async function getAllWorkflowRuns(): Promise<WorkflowRun[]> {
  const reader = await conn.runAndReadAll("SELECT * FROM workflow_runs ORDER BY startedAt DESC");
  return reader.getRowObjectsJS().map((row: any) => ({
    runId: row.runId,
    filePath: row.filePath,
    csvType: row.csvType,
    status: row.status,
    totalExpenses: row.totalExpenses,
    categorizedCount: row.categorizedCount,
    reviewQueueCount: row.reviewQueueCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

// Sub-expense operations

/**
 * Validates that sub-expense amounts sum to the parent expense amount
 * Throws an error if validation fails
 */
export function validateSubExpenseSums(parentAmount: number, subExpenseAmounts: number[]): void {
  const sum = subExpenseAmounts.reduce((acc, amount) => acc + amount, 0);
  const tolerance = 0.01; // Allow 1 cent tolerance for rounding

  if (Math.abs(sum - parentAmount) > tolerance) {
    throw new Error(
      `Sub-expense amounts ($${sum.toFixed(2)}) do not sum to parent expense amount ($${parentAmount.toFixed(2)}). ` +
      `Difference: $${Math.abs(sum - parentAmount).toFixed(2)}`
    );
  }
}

/**
 * Creates sub-expenses from a parent expense
 * Validates that sub-expense amounts sum to parent amount
 * Returns the created sub-expense IDs
 */
export async function createSubExpenses(
  parentExpense: Expense,
  subExpenseSplits: Array<{ description: string; amount: number; merchant?: string }>
): Promise<string[]> {
  const tableName = `expenses_${parentExpense.runId.replace(/-/g, '_')}`;

  // Validate amounts sum to parent
  validateSubExpenseSums(
    parentExpense.amount,
    subExpenseSplits.map(s => s.amount)
  );

  const subExpenseIds: string[] = [];

  try {
    for (const split of subExpenseSplits) {
      const subExpenseId = `${parentExpense.id}_sub_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      await conn.run(
        `INSERT INTO ${tableName}
         (id, runId, date, description, amount, merchant, source, parentExpenseId, isSubExpense)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          subExpenseId,
          parentExpense.runId,
          parentExpense.date,
          split.description,
          split.amount,
          split.merchant || parentExpense.merchant,
          parentExpense.source,
          parentExpense.id,
          true
        ]
      );

      subExpenseIds.push(subExpenseId);
    }

    logger.info({
      parentId: parentExpense.id,
      parentAmount: parentExpense.amount,
      subExpenseCount: subExpenseIds.length,
      subExpenseIds
    }, 'Created sub-expenses');

    return subExpenseIds;
  } catch (error) {
    logger.error({
      parentId: parentExpense.id,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to create sub-expenses');
    throw error;
  }
}

/**
 * Gets all sub-expenses for a parent expense
 */
export async function getSubExpenses(runId: string, parentExpenseId: string): Promise<Expense[]> {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;
  const reader = await conn.runAndReadAll(
    `SELECT * FROM ${tableName} WHERE parentExpenseId = ?`,
    [parentExpenseId]
  );

  // Our normalized fields that we extract (these get excluded from rawData)
  const normalizedFields = new Set(['id', 'runId', 'date', 'description', 'amount', 'merchant', 'source', 'parentExpenseId', 'isSubExpense']);

  return reader.getRowObjectsJS().map((row: any) => {
    // Build rawData from all non-normalized columns
    const rawData: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!normalizedFields.has(key) && value !== null && value !== undefined) {
        rawData[key] = value;
      }
    }

    return {
      id: row.id,
      runId: row.runId,
      date: row.date?.toISOString() || '',
      description: row.description || '',
      amount: row.amount || 0,
      merchant: row.merchant || '',
      source: row.source,
      parentExpenseId: row.parentExpenseId || null,
      isSubExpense: row.isSubExpense || false,
      rawData: Object.keys(rawData).length > 0 ? rawData : undefined,
    };
  });
}

