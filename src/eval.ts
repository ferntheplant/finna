import { conn } from "./db";
import type { Category } from "./types";
import { getCategoryPath } from "./categories";

export type RunStats = {
  runId: string;
  totalExpenses: number;
  categorizedCount: number;
  reviewQueueCount: number;
  uncategorizedCount: number;
  averageConfidence: number;
  categoryDistribution: Array<{
    categoryId: string;
    categoryName: string;
    categoryPath: string;
    count: number;
    percentage: number;
  }>;
  confidenceDistribution: {
    high: number; // >= 0.8
    medium: number; // 0.6-0.8
    low: number; // < 0.6
  };
};

export async function getRunStats(runId: string, categories: Category[]): Promise<RunStats> {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;

  // Get total expenses
  const totalReader = await conn.runAndReadAll(`SELECT COUNT(*) as count FROM ${tableName}`);
  const totalExpenses = Number(totalReader.getRowObjectsJS()[0]?.count || 0);

  // Get categorized count and average confidence
  const categorizationReader = await conn.runAndReadAll(`
    SELECT
      COUNT(*) as count,
      AVG(confidence) as avgConfidence
    FROM categorizations c
    WHERE c.expenseId IN (SELECT id FROM ${tableName})
  `);
  const categorizationData = categorizationReader.getRowObjectsJS()[0];
  const categorizedCount = Number(categorizationData?.count || 0);
  const averageConfidence = Number(categorizationData?.avgConfidence || 0);

  // Get review queue count
  const reviewReader = await conn.runAndReadAll(
    "SELECT COUNT(*) as count FROM review_queue WHERE runId = ? AND status = 'pending'",
    [runId]
  );
  const reviewQueueCount = Number(reviewReader.getRowObjectsJS()[0]?.count || 0);

  // Get category distribution
  const distributionReader = await conn.runAndReadAll(`
    SELECT
      c.categoryId,
      COUNT(*) as count
    FROM categorizations c
    WHERE c.expenseId IN (SELECT id FROM ${tableName})
    GROUP BY c.categoryId
    ORDER BY count DESC
  `);

  const categoryDistribution = distributionReader.getRowObjectsJS().map((row: any) => {
    const category = categories.find(cat => cat.id === row.categoryId);
    const count = Number(row.count);
    return {
      categoryId: row.categoryId,
      categoryName: category?.name || 'Unknown',
      categoryPath: getCategoryPath(row.categoryId, categories),
      count,
      percentage: totalExpenses > 0 ? (count / totalExpenses) * 100 : 0,
    };
  });

  // Get confidence distribution
  const confidenceReader = await conn.runAndReadAll(`
    SELECT
      SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.8 THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) as low
    FROM categorizations c
    WHERE c.expenseId IN (SELECT id FROM ${tableName})
  `);
  const confidenceData = confidenceReader.getRowObjectsJS()[0];
  const confidenceDistribution = {
    high: Number(confidenceData?.high || 0),
    medium: Number(confidenceData?.medium || 0),
    low: Number(confidenceData?.low || 0),
  };

  return {
    runId,
    totalExpenses,
    categorizedCount,
    reviewQueueCount,
    uncategorizedCount: totalExpenses - categorizedCount - reviewQueueCount,
    averageConfidence,
    categoryDistribution,
    confidenceDistribution,
  };
}

export async function getUncategorizedExpenses(runId: string) {
  const tableName = `expenses_${runId.replace(/-/g, '_')}`;

  const reader = await conn.runAndReadAll(`
    SELECT e.*
    FROM ${tableName} e
    LEFT JOIN categorizations c ON e.id = c.expenseId
    WHERE c.expenseId IS NULL
    ORDER BY e.date DESC
  `);

  return reader.getRowObjectsJS().map((row: any) => ({
    id: row.id,
    runId: row.runId,
    date: row.date?.toISOString() || '',
    description: row.description || '',
    amount: row.amount || 0,
    merchant: row.merchant || '',
    source: row.source,
  }));
}

export type RunComparison = {
  run1: RunStats;
  run2: RunStats;
  differences: {
    totalExpensesDiff: number;
    categorizedCountDiff: number;
    averageConfidenceDiff: number;
    categoryDistributionChanges: Array<{
      categoryId: string;
      categoryName: string;
      categoryPath: string;
      run1Count: number;
      run2Count: number;
      diff: number;
    }>;
  };
};

export async function compareRuns(
  runId1: string,
  runId2: string,
  categories: Category[]
): Promise<RunComparison> {
  const run1Stats = await getRunStats(runId1, categories);
  const run2Stats = await getRunStats(runId2, categories);

  // Get all unique category IDs from both runs
  const allCategoryIds = new Set([
    ...run1Stats.categoryDistribution.map(d => d.categoryId),
    ...run2Stats.categoryDistribution.map(d => d.categoryId),
  ]);

  const categoryDistributionChanges = Array.from(allCategoryIds).map(categoryId => {
    const run1Entry = run1Stats.categoryDistribution.find(d => d.categoryId === categoryId);
    const run2Entry = run2Stats.categoryDistribution.find(d => d.categoryId === categoryId);
    const category = categories.find(c => c.id === categoryId);

    return {
      categoryId,
      categoryName: category?.name || 'Unknown',
      categoryPath: getCategoryPath(categoryId, categories),
      run1Count: run1Entry?.count || 0,
      run2Count: run2Entry?.count || 0,
      diff: (run2Entry?.count || 0) - (run1Entry?.count || 0),
    };
  }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)); // Sort by largest change

  return {
    run1: run1Stats,
    run2: run2Stats,
    differences: {
      totalExpensesDiff: run2Stats.totalExpenses - run1Stats.totalExpenses,
      categorizedCountDiff: run2Stats.categorizedCount - run1Stats.categorizedCount,
      averageConfidenceDiff: run2Stats.averageConfidence - run1Stats.averageConfidence,
      categoryDistributionChanges,
    },
  };
}

