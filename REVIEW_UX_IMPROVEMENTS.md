# Review Queue UX Improvements

## Summary of Changes

This document outlines the improvements made to the expense categorization review queue system.

## 1. Clear Separation of Review Reasons

### New Review Queue Reasons
The system now distinguishes between the following review reasons:

- **`low_confidence`** - AI categorization confidence below threshold
- **`obfuscated_merchant`** - Generic merchant name that needs clarification
- **`new_category_suggestion`** - AI suggested creating a genuinely new category
- **`duplicate_category_suggested`** ⭐ NEW - AI suggested creating a category that already exists
- **`amazon_should_split`** ⭐ NEW - Amazon purchase that should be split into individual items
- **`ambiguous`** ⭐ NEW - Generic ambiguous case requiring manual review
- **`llm_failure`** - AI categorization failed after multiple retries

### UI Updates
- Review queue list shows color-coded badges for each reason type
- Detail page shows specific guidance based on the reason
- Amazon purchases are clearly marked with 🛒 emoji

**Files Modified:**
- `src/types.ts` - Added new reason types
- `src/inngest/categorizeExpense.ts` - Logic to detect and assign appropriate reasons
- `public/review.html` - Badge styling and display
- `public/review-detail.html` - Reason-specific help text

## 2. Duplicate Category Detection (Bug Fix)

### Problem
The LLM was suggesting creating categories that already existed in the database, causing unnecessary review queue items.

### Solution
Added validation in `handleNewCategoryRequest()` that checks if a suggested category already exists before adding to the review queue:

1. If the category name already exists (case-insensitive), the system:
   - Marks it as `duplicate_category_suggested` or `amazon_should_split` (if Amazon)
   - Suggests using the existing category instead
   - Avoids creating duplicates

**Files Modified:**
- `src/inngest/categorizeExpense.ts` - Added `findCategoryByName()` check
- `src/db-operations.ts` - Already had the needed function

## 3. Auto-Retry When Categories Are Created

### Feature
When a new category is created during manual review, the system automatically:

1. Triggers a background Inngest workflow (`category/created` event)
2. Finds all pending review items with reasons:
   - `new_category_suggestion`
   - `duplicate_category_suggested`
3. Re-runs LLM categorization with the updated category list
4. If the LLM can now categorize with high confidence (≥0.7):
   - Automatically categorizes the expense
   - Resolves the review item
   - Updates workflow stats
   - Marks as `retry_auto` source

This dramatically reduces manual review work as similar expenses are auto-resolved.

**Important:** The retry logic runs **asynchronously** in the background, so the UI response is immediate and doesn't block on LLM calls.

**Files Modified:**
- `src/handlers/review.ts` - Sends `category/created` event asynchronously
- `src/inngest/retryPendingAfterCategoryCreation.ts` - New Inngest function to handle retries
- `src/inngest/index.ts` - Registered new function
- `src/inngest/types.ts` - Added `CategoryCreated` event type

## 4. Annotations When Accepting Suggestions

### Feature
Users can now add annotations when accepting AI suggestions, not just when manually categorizing.

The annotation field is always available and included when:
- Accepting an existing category suggestion
- Accepting and creating a new category
- Manually selecting a category

Annotations help the AI learn context for future similar expenses.

**Files Modified:**
- `public/review-detail.html` - Updated `acceptExistingCategorySuggestion()` and `acceptNewCategorySuggestion()`

## 5. Aggressive Subcategory Creation for Discretionary Spending

### Problem
The LLM was not creating enough specific subcategories, especially for discretionary spending, resulting in generic "Discretionary" or "Shopping" categorizations that provided limited insight.

### Solution
Updated the LLM prompt with:

1. **MANDATORY subcategories** - A comprehensive list of subcategories that should always be created:
   - Restaurants & Cafes
   - Bars & Nightlife / Alcohol & Beverages
   - Clothing & Apparel
   - Electronics & Tech
   - Entertainment & Media
   - Home Decor & Furniture
   - Books & Media
   - Hobbies & Crafts
   - Beauty & Personal Care
   - Gifts & Occasions
   - Coffee Shops / Cafes
   - Fast Food & Takeout

2. **CRITICAL RULE**: "If you're about to categorize something as 'Discretionary', 'Shopping', 'Food', or any other broad parent category, STOP and CREATE A SPECIFIC SUBCATEGORY instead!"

3. **Examples** of good subcategory creation

4. **Default behavior**: "When in doubt about whether to create a subcategory for discretionary spending, ALWAYS CREATE IT"

**Files Modified:**
- `src/llm.ts` - Updated prompt in `categorizeExpense()` function

## Benefits

1. **Clearer Review Queue** - Users immediately understand why items need review
2. **Fewer Duplicates** - System catches LLM mistakes before they enter review queue
3. **Less Manual Work** - Auto-retry resolves pending items when new categories are added
4. **Better Context** - Annotations can be added when accepting suggestions
5. **More Insights** - Aggressive subcategorization makes Sankey diagrams more meaningful

## Testing Recommendations

1. Process a CSV with Amazon purchases - verify they're marked as "Amazon - Should Split"
2. Create a new category during review - verify pending items are auto-retried
3. Accept an AI suggestion - verify you can add an annotation along with it
4. Check that discretionary spending gets specific subcategories (Restaurants, Clothing, etc.) rather than generic "Discretionary"
5. Verify the LLM doesn't suggest creating categories that already exist

## Migration Notes

- No database migrations required (reason field already supports strings)
- Existing review queue items will continue to work with old reason types
- New behavior applies to newly categorized expenses

## Bug Fix: Slow Review Submission

### Problem
When creating a new subcategory during review, the submit button would hang on "Submitting..." and the page wouldn't redirect back to the review list. The submission worked, but the frontend didn't update.

### Root Cause
The `checkAndRetryPendingReviews()` function was running synchronously and blocking the HTTP response. Since it calls the LLM for each pending item, this could take 30+ seconds.

### Solution
Changed the retry logic to run asynchronously via Inngest:
1. The HTTP response returns immediately after saving the categorization
2. A `category/created` event is sent to Inngest (not awaited)
3. A new Inngest function `retryPendingAfterCategoryCreation` handles the retry logic in the background
4. The user is redirected to the review list immediately

This provides a much better UX - the page responds instantly, and pending items get resolved in the background.

