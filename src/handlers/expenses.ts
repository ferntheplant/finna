import { getExpenses, getCategorization } from '../db-operations';

export async function handleGetExpenses(runId: string): Promise<Response> {
  try {
    const expenses = await getExpenses(runId);

    // Also fetch categorizations for each
    const expensesWithCategories = await Promise.all(
      expenses.map(async (exp) => {
        const categorization = await getCategorization(exp.id);
        return {
          ...exp,
          categorization,
        };
      })
    );

    return new Response(JSON.stringify(expensesWithCategories), {
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

