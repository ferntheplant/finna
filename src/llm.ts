import { Ollama } from "ollama";
import type { Expense, Category, CategorizationResponse } from "./types";
import type { SimilarCategorizedExpense } from "./db-operations";
import { formatCategoriesForPrompt } from "./categories";
import type { Logger } from "inngest";
import { createLogger } from "./logger";

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "http://localhost:11434",
  // Note: The Ollama client doesn't expose timeout configuration directly
  // Timeouts are handled by:
  // 1. Ollama server-side settings (OLLAMA_* env vars)
  // 2. Our retry mechanism (5 retries with exponential backoff)
  // 3. Inngest's step timeout (default 60s, can be configured per step)
});

// Default to llama3.1 - avoid reasoning models like deepseek-r1 for JSON output
const MODEL = process.env.OLLAMA_MODEL || "llama3.1";
const defaultLogger = createLogger('llm');

// Note: If using deepseek-r1 or other reasoning models, expect JSON parsing issues
// Recommended models: llama3.1, qwen2.5, qwen3, mistral

export async function categorizeExpense(
  expense: Expense,
  categories: Category[],
  logger: Logger = defaultLogger,
  similarExpenses: SimilarCategorizedExpense[] = [],
  currentExpenseAnnotation?: string
): Promise<CategorizationResponse> {

  const categoriesText = formatCategoriesForPrompt(categories);

  // Extract Category field from raw data if available (credit card CSVs often have this)
  const csvCategory = expense.rawData?.Category || expense.rawData?.category;

  // Format similar expenses as examples
  let similarExpensesText = '';
  if (similarExpenses.length > 0) {
    similarExpensesText = `\n\nSIMILAR PREVIOUSLY CATEGORIZED EXPENSES:
You have already categorized similar expenses in the past. Use these as reference to maintain consistency:

${similarExpenses.map((similar, idx) => `${idx + 1}. Merchant: "${similar.merchant}" | Description: "${similar.description}" | Amount: $${similar.amount.toFixed(2)}
   → Categorized as: ${similar.categoryName} (${similar.categoryId})
   → Reasoning: ${similar.reasoning}
   → Similarity: ${(similar.similarityScore * 100).toFixed(0)}%${similar.annotation ? `\n   → ANNOTATION: ${similar.annotation}` : ''}`).join('\n\n')}

CRITICAL RULES FOR USING SIMILAR EXPENSES:
1. If you see a similar expense was categorized to a SPECIFIC subcategory (like "Restaurants & Cafes"), use THAT EXACT CATEGORY ID, not its parent.
2. ALWAYS prefer the most specific category available. Never suggest a parent category when a more specific child exists.
3. These examples show you the EXACT category to reuse - use the categoryId shown, don't try to generalize to a parent.
4. If the current expense is truly different, don't force it - but if it's similar, use the EXACT SAME CATEGORY ID shown above.
5. Pay special attention to ANNOTATION fields - they contain important manual context added by the user during review.`;
  }

  const prompt = `You are an expense categorization assistant helping to build a SANKEY DIAGRAM that visualizes spending patterns. Your categorization choices directly impact how useful and insightful this visualization will be.

THE END GOAL - SANKEY DIAGRAM:
A Sankey diagram shows money flowing from Root → Category → Subcategory → Individual Expenses. The goal is to create meaningful, specific subcategories that reveal spending patterns. For example:
- "Essentials" → "Groceries", "Household Items", "Personal Care"
- "Discretionary" → "Clothing", "Electronics", "Eating Out"
- "Health" → "Gym Membership", "Medical Appointments", "Supplements"

CURRENT CATEGORY HIERARCHY:
${categoriesText}
${similarExpensesText}

EXPENSE TO CATEGORIZE:
- Date: ${expense.date}
- Merchant: ${expense.merchant}
- Description: ${expense.description}
- Amount: $${expense.amount.toFixed(2)}${csvCategory ? `\n- CSV Category: ${csvCategory} (context from credit card company)` : ''}${currentExpenseAnnotation ? `\n- ANNOTATION: ${currentExpenseAnnotation} (important manual context from previous review)` : ''}

CATEGORIZATION PHILOSOPHY:
1. ALWAYS USE THE MOST SPECIFIC CATEGORY: When categorizing, ALWAYS choose the most specific subcategory available. NEVER suggest a parent category when a more specific child category exists. For example, if "Restaurants & Cafes" exists under "Discretionary", use "Restaurants & Cafes", NOT "Discretionary".

2. PRIORITIZE DESCRIPTION OVER MERCHANT: A descriptive item name (like "Men's Running Shorts 3-Pack" from Amazon) contains enough information to categorize accurately, even if the merchant is generic like "Amazon" or "Sold by Amazon".

3. CREATE SPECIFIC SUBCATEGORIES LIBERALLY: If you see a purchase that doesn't fit existing categories well, CREATE A NEW SUBCATEGORY! This is ESPECIALLY important for "Discretionary" spending - use CSV hints like "Restaurant and Bar" to create specific subcategories. Examples:
   - "Running Shorts 3-Pack" → Create "Clothing & Apparel" under "Discretionary" or "Shopping"
   - Restaurant purchase → Create "Restaurants & Cafes" or "Dining Out" under "Discretionary"
   - "Protein Powder" → Create "Supplements" under "Health"
   - "Dog Food" → Create "Pet Supplies" under "Shopping" or create new "Pets" category
   - "Oil Change" → Create "Vehicle Maintenance" under "Transportation"
   - Bar/Alcohol → Create "Bars & Nightlife" or "Alcohol" under "Discretionary"
   - Entertainment → Create "Entertainment & Leisure" under "Discretionary"

4. ONLY REQUEST HUMAN REVIEW if the description is TRULY uninformative and you cannot determine what was purchased. Examples that DON'T need review:
   ✓ "Sold by Amazon.com" with description "Anker USB-C Cable 3-pack" → Clearly electronics
   ✓ "Venmo Payment" with description "Dinner split with Sarah" → Clearly restaurants/food
   ✓ Generic merchant but specific description → USE THE DESCRIPTION

5. WHEN TO CREATE NEW CATEGORIES
   - FIRST, CAREFULLY REVIEW THE ENTIRE CATEGORY LIST ABOVE! Don't create a new category if a similar one already exists!
   - Check for variations: "Clothing & Apparel" vs "Clothing", "Home Decor & Furniture" vs "Furniture", "Restaurants & Cafes" vs "Dining Out"
   - The purchase represents a distinct spending pattern worth tracking
   - It's specific enough to be meaningful (not too broad like "Stuff")
   - It's general enough to be reusable (not "That one time I bought a thing")
   - It helps answer "Where does my money go?" in the Sankey diagram
   - IMPORTANT: For "Discretionary" spending, ALWAYS create specific subcategories! Don't just use the parent "Discretionary" category. Create "Restaurants & Cafes", "Clothing", "Entertainment", "Bars & Nightlife", etc.
   - Use CSV Category hints (like "Restaurant and Bar") as strong signals to create appropriate subcategories

EXAMPLES OF GOOD CATEGORIZATION:
Example 1: "Sold by Amazon", description "Nike Running Shoes"
→ Action: create_subcategory, name: "Clothing & Apparel", parent: "Shopping"

Example 2: "Target", description "Groceries and household items"
→ Action: create_subcategory, name: "Groceries", parent: "Food" (if Food exists)

Example 3: "Joe's Auto Shop", description "Oil change"
→ Action: create_subcategory, name: "Vehicle Maintenance", parent: "Transportation"

Example 4: Merchant: "PayPal", Description: "Transfer" with $500
→ Action: needs_human_review (truly unclear what this is for)

RESPONSE FORMAT - CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no code blocks, no explanations. Just pure JSON:
{
  "action": "categorize" | "create_subcategory" | "needs_human_review",
  "categoryId": "ID of the category if action is 'categorize'",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your decision",
  "newCategory": {
    "name": "Name for new subcategory (descriptive, e.g. 'Clothing & Apparel', 'Home Improvement', 'Pet Supplies')",
    "description": "What expenses belong here (e.g. 'Clothing, shoes, accessories and apparel')",
    "parentId": "ID of parent category (NOT Root '0', must be an existing category)"
  }
}

IMPORTANT:
- Only include "newCategory" if action is "create_subcategory"
- Only include "categoryId" if action is "categorize"
- Be bold about creating subcategories - they make the Sankey diagram more insightful!
- A descriptive item name is usually enough to categorize, even with a generic merchant
- Your ENTIRE response must be valid JSON - nothing before, nothing after`;

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
    if (!parsed.action) {
      logger.warn({
        expenseId: expense.id,
        rawContent: content.substring(0, 500), // Log first 500 chars
      }, 'LLM response missing action field');
      throw new Error(`Invalid response format from LLM: missing action`);
    }

    // Ensure reasoning is present (provide defaults if missing)
    if (!parsed.reasoning) {
      if (parsed.action === 'create_subcategory' && parsed.newCategory) {
        parsed.reasoning = `Creating new subcategory: ${parsed.newCategory.name}`;
      } else if (parsed.action === 'categorize') {
        parsed.reasoning = 'Categorized based on expense details';
      } else {
        parsed.reasoning = 'Needs human review';
      }
    }

    // Ensure confidence is present for categorize actions
    if (parsed.action === 'categorize' && typeof parsed.confidence !== 'number') {
      parsed.confidence = 0.5; // Default to medium-low confidence if not provided
    }

    // For create_subcategory, ensure we have newCategory and confidence
    if (parsed.action === 'create_subcategory') {
      if (!parsed.newCategory || !parsed.newCategory.name || !parsed.newCategory.description || !parsed.newCategory.parentId) {
        logger.warn({
          expenseId: expense.id,
          rawContent: content.substring(0, 500),
        }, 'LLM response missing required newCategory fields');
        throw new Error(`Invalid response format from LLM: create_subcategory missing newCategory details`);
      }
      // Default confidence for new category suggestions
      if (typeof parsed.confidence !== 'number') {
        parsed.confidence = 0.8; // Medium-high confidence for category creation
      }
    }

    return parsed as CategorizationResponse;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.toLowerCase().includes('timeout') ||
                      errorMessage.toLowerCase().includes('timed out') ||
                      errorMessage.toLowerCase().includes('econnaborted');

    logger.error({
      model: MODEL,
      ollamaHost: process.env.OLLAMA_HOST || "http://localhost:11434",
      expenseId: expense.id,
      merchant: expense.merchant,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      isTimeout,
    }, 'Error calling Ollama');

    // For timeout errors, throw to trigger Inngest retries with exponential backoff
    // This lets the LLM server cool down between retries
    if (isTimeout) {
      logger.warn({
        expenseId: expense.id,
        merchant: expense.merchant,
      }, 'LLM timeout - throwing error to trigger retry with backoff');
      throw error;
    }

    // For other errors (JSON parsing, etc), fallback to human review
    return {
      action: 'needs_human_review',
      reasoning: `Error during categorization: ${errorMessage}`,
    };
  }
}

