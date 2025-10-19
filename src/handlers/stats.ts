import { getAllCategories } from '../db-operations';
import { getRunStats, getUncategorizedExpenses, compareRuns } from '../eval';

export async function handleGetStats(runId: string): Promise<Response> {
  try {
    const categories = await getAllCategories();
    const stats = await getRunStats(runId, categories);

    return new Response(JSON.stringify(stats), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function handleGetUncategorized(runId: string): Promise<Response> {
  try {
    const expenses = await getUncategorizedExpenses(runId);

    return new Response(JSON.stringify(expenses), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function handleCompareRuns(runId1: string, runId2: string): Promise<Response> {
  try {
    const categories = await getAllCategories();
    const comparison = await compareRuns(runId1, runId2, categories);

    return new Response(JSON.stringify(comparison), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

