# Changelog

## Recent Improvements (October 2025)

### 🔑 Stable Expense IDs
**Problem**: Same expense got different IDs on each import, causing duplicate categorizations.

**Solution**: Generate IDs from content hash (MD5 of Date+Description+Amount+Merchant).

**Benefits**:
- Same expense always gets same ID across imports
- Re-importing updates existing categorizations (no duplicates)
- Categorizations table stays clean

**Files Changed**: `src/db-operations.ts`

---

### 💾 Raw CSV Data Preservation
**Problem**: Lost valuable context from original CSV (Category field, Address, Reference numbers).

**Solution**: Store all original CSV columns alongside normalized fields using `SELECT * EXCLUDE (...)`.

**Benefits**:
- Review UI shows all original CSV data
- LLM receives CSV Category field for better context
- Helps identify unclear transactions (addresses, reference numbers)
- Category field highlighted in review UI

**Files Changed**: `src/db-operations.ts`, `src/types.ts`, `public/review-detail.html`

---

### 🛒 Amazon Purchase Splitting UI
**Problem**: Had to manually enter Amazon item splits via API or browser console.

**Solution**: Added UI in review page to paste JSON directly from parse-amazon.js.

**Features**:
- Auto-detects Amazon expenses
- Shows "🛒 Split Amazon Purchase" button
- Paste JSON from browser console
- Real-time validation and preview
- Shows item breakdown and charge summary
- Validates amounts match total
- Distributes shipping/taxes automatically

**Files Changed**: `public/review-detail.html`, `src/handlers/review.ts`

---

### 🤖 LLM Improvements
**Problem**: Reasoning models (deepseek-r1) broke JSON output with thinking process.

**Solutions**:
- Added model recommendations to docs
- Extract JSON from markdown code blocks
- Better error logging (shows first 500 chars of response)
- Added `think: false` option for reasoning models

**Recommended Models**: llama3.1, qwen3, qwen2.5:7b
**Avoid**: deepseek-r1 and other reasoning models

**Files Changed**: `src/llm.ts`, `README.md`, `docs/ARCHITECTURE.md`

---

### ⚡ Event-Driven Completion
**Problem**: Workflow used 1-hour sleep, even if categorizations finished in 5 minutes.

**Solution**: Track progress and send completion event when done.

**How It Works**:
- Each categorization updates `categorizedCount` or `reviewQueueCount`
- When `categorizedCount + reviewQueueCount == totalExpenses`, send `expenses/processing.completed` event
- Main workflow uses `step.waitForEvent()` instead of sleep
- Completes immediately when all done (2-hour timeout for edge cases)

**Performance**: 5-minute job completes in 5 minutes (not 65 minutes!)

**Files Changed**: `src/inngest/processExpenses.ts`, `src/inngest/categorizeExpense.ts`, `src/inngest/types.ts`

---

### 🔧 BigInt Serialization Fix
**Problem**: DuckDB returns BigInt values that break JSON.stringify.

**Solution**: Added `safeJsonStringify()` helper that converts BigInt → Number.

**Files Changed**: `src/handlers/review.ts`

---

### ♻️ Graceful Duplicate Handling
**Problem**: Re-importing same CSV caused errors from duplicate inserts.

**Solutions**:
- Review queue: `INSERT OR IGNORE` (silently skip duplicates)
- Categorizations: `INSERT OR REPLACE` (update in place)

**Files Changed**: `src/db-operations.ts`

---

### 📝 Column Conflict Fix
**Problem**: CSV columns (Date, Description, Amount) conflicted with normalized columns, causing empty values in UI.

**Solution**: Use `SELECT * EXCLUDE (Date, Description, Amount, ...)` and store originals as `rawDate`, `rawDescription`, etc.

**Files Changed**: `src/db-operations.ts`

---

## Documentation Updates

- Updated `README.md` with new features and troubleshooting
- Updated `docs/ARCHITECTURE.md` with technical details
- Added model recommendations and warnings
- Documented Amazon UI workflow
- Added troubleshooting section for common issues

---

## Breaking Changes

None! All changes are backwards compatible.

## Migration Notes

### Existing Databases
- Expenses from old imports won't have `rawData` (only new imports)
- Old expense IDs (random UUIDs) will remain, new imports get hash-based IDs
- No schema migration needed

### Environment Variables
- `OLLAMA_MODEL` now defaults to `llama3.1` (was previously `llama3.1` anyway)
- Consider setting explicitly if using a different model

---

## Future Improvements

Potential areas for enhancement:
- [ ] Migrate existing expenses to hash-based IDs
- [ ] Add UI for manual transaction splitting (without Amazon)
- [ ] Support more CSV formats
- [ ] Export categorized expenses to accounting software
- [ ] Batch review actions (categorize multiple at once)

