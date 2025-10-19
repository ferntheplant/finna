import type { Category } from "./types";

export const ROOT_CATEGORIES: Category[] = [
  {
    id: "0",
    name: "Root",
    description: "The root category; this is the top-level category that all other categories are nested under.",
    parentId: null,
  },
  {
    id: "1",
    name: "Fixed Costs",
    description: "Expenses that individuals cannot change much via their own actions; think rent, utilities, taxes, etc.",
    parentId: "0",
  },
  {
    id: "2",
    name: "Healthcare",
    description: "Formal healthcare; think insurance, copays, pharmacy, etc. (note: this does not include personal care like supplements, vitamins, etc.)",
    parentId: "0",
  },
  {
    id: "3",
    name: "Pets",
    description: "Expenses for pets; think food, toys, veterinary, etc.",
    parentId: "0",
  },
  {
    id: "4",
    name: "Essentials",
    description: "The basics in life that can't easily be cut back; think groceries, household items, personal care, subway passes, etc",
    parentId: "0",
  },
  {
    id: "5",
    name: "Discretionary",
    description: "Discretionary items that could be cut back if needed; think both exeriences like entertainment or dining out as well as purchases of non-essential items like extra clothing, electronics, etc.",
    parentId: "0",
  },
  {
    id: "6",
    name: "Vacation",
    description: "Everything related to vacations; think flights, hotels, rental cars, food while away, etc.",
    parentId: "0",
  },
  {
    id: "7",
    name: "Investments",
    description: "Investments where no immediate value is expected; think stocks, retirement accounts, equity options, etc.",
    parentId: "0",
  },
  {
    id: "8",
    name: "Other",
    description: "Anything that does not fit into any other category; (note: this should be almost never used - see if a subcategory is more appropriate)",
    parentId: "0",
  }
];

// Build full hierarchy path for a category (e.g., "Root > Discretionary > Dining")
export function getCategoryPath(categoryId: string, allCategories: Category[]): string {
  const category = allCategories.find(c => c.id === categoryId);
  if (!category) return "";

  if (category.parentId === null) {
    return category.name;
  }

  const parentPath = getCategoryPath(category.parentId, allCategories);
  return `${parentPath} > ${category.name}`;
}

// Get all categories formatted for LLM prompt
export function formatCategoriesForPrompt(categories: Category[]): string {
  const lines: string[] = [];

  function addCategory(cat: Category, indent: number = 0) {
    const prefix = "  ".repeat(indent);
    lines.push(`${prefix}- [${cat.id}] ${cat.name}: ${cat.description}`);

    // Add children
    const children = categories.filter(c => c.parentId === cat.id);
    for (const child of children) {
      addCategory(child, indent + 1);
    }
  }

  // Start with root
  const root = categories.find(c => c.id === "0");
  if (root) {
    addCategory(root);
  }

  return lines.join("\n");
}
