import { getAllCategories, createCategory } from '../db-operations';
import { getCategoryPath } from '../categories';

export async function handleGetCategories(): Promise<Response> {
  const categories = await getAllCategories();

  // Add full paths to each category
  const categoriesWithPaths = categories.map(cat => ({
    ...cat,
    path: getCategoryPath(cat.id, categories),
  }));

  return new Response(JSON.stringify(categoriesWithPaths), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleCreateCategory(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { name, description, parentId } = body;

    if (!name || !description || !parentId) {
      return new Response(JSON.stringify({
        error: "name, description, and parentId required"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const id = `cat_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await createCategory({ id, name, description, parentId });

    return new Response(JSON.stringify({ id, name, description, parentId }), {
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

