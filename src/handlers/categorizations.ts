import { updateAnnotation, getCategorization } from '../db-operations';

/**
 * Update annotation for a categorized expense
 * PATCH /api/categorizations/:expenseId/annotation
 */
export async function handleUpdateAnnotation(expenseId: string, request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { annotation } = body;

    // Validate that the expense is categorized
    const existing = await getCategorization(expenseId);
    if (!existing) {
      return new Response(JSON.stringify({
        error: "Expense not categorized yet. Annotations can only be added to categorized expenses."
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Allow null or empty string to clear annotation
    const normalizedAnnotation = annotation === null || annotation === '' ? null : String(annotation);

    await updateAnnotation(expenseId, normalizedAnnotation);

    return new Response(JSON.stringify({
      success: true,
      expenseId,
      annotation: normalizedAnnotation
    }), {
      status: 200,
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

/**
 * Get categorization with annotation for an expense
 * GET /api/categorizations/:expenseId
 */
export async function handleGetCategorization(expenseId: string): Promise<Response> {
  try {
    const categorization = await getCategorization(expenseId);

    if (!categorization) {
      return new Response(JSON.stringify({
        error: "Categorization not found"
      }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(categorization), {
      status: 200,
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

