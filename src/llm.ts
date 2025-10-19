import { Ollama } from "ollama";
import type { Expense, Category, CategorizationResponse } from "./types";
import { formatCategoriesForPrompt } from "./categories";
import type { Logger } from "inngest";
import { createLogger } from "./logger";

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "http://localhost:11434",
});

// Default to llama3.1 - avoid reasoning models like deepseek-r1 for JSON output
const MODEL = process.env.OLLAMA_MODEL || "llama3.1";
const defaultLogger = createLogger('llm');

// Note: If using deepseek-r1 or other reasoning models, expect JSON parsing issues
// Recommended models: llama3.1, qwen2.5, qwen3, mistral

// Merchants that are too vague and need human clarification
const OBFUSCATED_MERCHANTS = [
  'amazon',
  'venmo',
  'paypal',
  'cash app',
  'zelle',
  'apple pay',
  'google pay',
  'square',
];

export function isObfuscatedMerchant(merchant: string): boolean {
  const merchantLower = merchant.toLowerCase();
  return OBFUSCATED_MERCHANTS.some(obf => merchantLower.includes(obf));
}

export async function categorizeExpense(
  expense: Expense,
  categories: Category[],
  logger: Logger = defaultLogger
): Promise<CategorizationResponse> {
  // Check for obfuscated merchants first
  if (isObfuscatedMerchant(expense.merchant)) {
    return {
      action: 'needs_human_review',
      reasoning: `Merchant "${expense.merchant}" is too generic. Human clarification needed for actual purchase.`,
    };
  }

  const categoriesText = formatCategoriesForPrompt(categories);

  // Extract Category field from raw data if available (credit card CSVs often have this)
  const csvCategory = expense.rawData?.Category || expense.rawData?.category;

  const prompt = `You are an expense categorization assistant. Given an expense transaction, you must categorize it into the appropriate category from the provided hierarchy. You have significant freedom to adjust the category hierarchy as needed.

CATEGORY HIERARCHY:
${categoriesText}

EXPENSE TO CATEGORIZE:
- Date: ${expense.date}
- Merchant: ${expense.merchant}
- Description: ${expense.description}
- Amount: $${expense.amount.toFixed(2)}${csvCategory ? `\n- CSV Category: ${csvCategory} (this is valuable context from the credit card company)` : ''}

INSTRUCTIONS:
1. Analyze the expense and determine the most appropriate category
2. If an existing category fits well (confidence >= 0.7), use it
3. If no category fits well, you have FULL FREEDOM to:
   - Create new subcategories under any existing category
   - Create new top-level categories under Root (id: "0") if none of the existing root categories are appropriate
   - Suggest deeper nesting (sub-subcategories) for more specific categorization
   - Be creative with category names and structure to best represent spending patterns
4. If you're uncertain (confidence < 0.7) or the merchant is too generic to categorize without more information, indicate that human review is needed
5. When creating categories, think about:
   - Would this be useful for tracking spending over time?
   - Is this specific enough to be meaningful but general enough to be reusable?
   - Does this fit logically within the hierarchy?

RESPONSE FORMAT - CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no code blocks, no explanations, no thinking process. Just pure JSON:
{
  "action": "categorize" | "create_subcategory" | "needs_human_review",
  "categoryId": "ID of the category if action is 'categorize'",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your decision",
  "newCategory": {
    "name": "Name for new subcategory (be descriptive and specific)",
    "description": "Description of what this subcategory covers",
    "parentId": "ID of parent category (can be any category EXCEPT Root (id: "0"))"
  }
}

IMPORTANT:
- Only include "newCategory" if action is "create_subcategory"
- Only include "categoryId" if action is "categorize"
- Your ENTIRE response must be valid JSON - nothing before, nothing after
- Do NOT include any reasoning or thinking process outside the JSON`;

  try {
    const response = await ollama.chat({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      format: "json",
      think: false,
      options: {
        temperature: 0.1, // Low temperature for more consistent categorization
      },
    });

    const content = response.message.content.trim();

    // Try to extract JSON if it's wrapped in markdown code blocks or has extra text
    let jsonContent = content;
    if (content.includes('```json')) {
      const match = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        jsonContent = match[1].trim();
      }
    } else if (content.includes('```')) {
      const match = content.match(/```\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        jsonContent = match[1].trim();
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonContent);
    } catch (parseError) {
      // Log the actual content that failed to parse
      logger.error({
        model: MODEL,
        expenseId: expense.id,
        merchant: expense.merchant,
        rawContent: content.substring(0, 500), // Log first 500 chars
        error: parseError instanceof Error ? parseError.message : String(parseError),
      }, 'Failed to parse LLM response as JSON');

      throw new Error(`Invalid JSON from LLM: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }

    // Validate response
    if (!parsed.action || !parsed.reasoning) {
      logger.warn({
        expenseId: expense.id,
        rawContent: content.substring(0, 500), // Log first 500 chars
      }, 'LLM response missing required fields');
      throw new Error(`Invalid response format from LLM: missing action or reasoning`);
    }

    // Ensure confidence is present for categorize and create_subcategory actions
    if (parsed.action === 'categorize' && typeof parsed.confidence !== 'number') {
      parsed.confidence = 0.5; // Default to medium-low confidence if not provided
    }

    return parsed as CategorizationResponse;
  } catch (error) {
    logger.error({
      model: MODEL,
      ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
      expenseId: expense.id,
      merchant: expense.merchant,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Error calling Ollama');

    // Fallback to human review on any error
    return {
      action: 'needs_human_review',
      reasoning: `Error during categorization: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

