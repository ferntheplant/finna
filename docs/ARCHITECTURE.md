# Architecture

## Tech Stack

- **Bun** - HTTP server and runtime
- **Inngest** - Durable workflow engine for human-in-the-loop
- **DuckDB** - ACID-compliant embedded database
- **Ollama** - Local LLM inference
- **Pino** - Structured logging (JSON file + pretty console)

## Data Flow

```
CSV Upload → POST /api/process-csv
  ↓
Inngest: processExpenses workflow
  ├─ Ingest CSV → DuckDB table (expenses_<runId>)
  │   └─ Generate stable IDs: md5(Date+Description+Amount+Merchant)
  ├─ Trigger categorizeExpense for each expense (throttled)
  │     ↓
  │   categorizeExpense workflow (completes immediately)
  │     ├─ Fetch expense, categories, similar expenses
  │     ├─ Call Ollama LLM
  │     ├─ High confidence (≥0.7) → Save + send expense.categorized event
  │     ├─ Low confidence → Add to review queue + send expense.needs_review event
  │     └─ LLM failure (5+ retries) → onFailure adds to review queue + sends expense.failed event
  │
  └─ Parent workflow completes (no waiting)

Human reviews at /review UI
  ↓
POST /api/review/:id/categorize
  ↓
Triggers completeReviewedExpense workflow
  ├─ Save categorization (source='manual')
  └─ Send expense.categorized event

trackRunCompletion workflow (batched, event-driven)
  ├─ Listens to: expense.categorized, expense.needs_review, expense.failed
  ├─ Checks: categorizedCount + reviewQueueCount + failedCount === totalExpenses
  └─ Updates run status to 'categorization_done'
```

## Key Design Patterns

### Stable Expense IDs
Content-based hashing (MD5 of Date+Description+Amount+Merchant):
- Same expense = same ID across re-imports
- Re-imports update existing categorizations (INSERT OR REPLACE)
- No duplicate categorizations

### Raw Data Preservation
- Store all original CSV columns using `SELECT * EXCLUDE (...)`
- Normalize common fields separately (date, amount, description)
- Display raw CSV data in review UI for context
- LLM receives CSV Category field for better accuracy

### Event-Driven Workflows
- Workflows complete immediately (no blocking waits)
- Emit tracking events: `expense.categorized`, `expense.needs_review`, `expense.failed`
- Batched completion detection via `trackRunCompletion` (100 events per 5s)
- No race conditions, eventually consistent

### Categorization Source Tracking
- `auto` - High-confidence LLM without review
- `manual` - Human selected in review UI
- `retry_auto` - Retry achieved high confidence and auto-resolved

### Table-Per-Run
Each processing run gets its own expense table for isolation and easy comparison.

## Inngest Workflows

**processExpenses** - Parent orchestrator
- Duration: seconds to minutes (CSV size dependent)
- Ingests CSV, creates run record, triggers categorization events
- Completes immediately (no waiting)

**categorizeExpense** - Per-expense worker
- Duration: seconds to minutes (LLM call + DB)
- Throttled: 2 concurrent per 15s per run
- Retries: 5 attempts with exponential backoff
- onFailure: Adds to review queue with status='llm_failure'
- Completes immediately after save or queue add

**completeReviewedExpense** - Human resolution handler
- Trigger: `review/item.resolved` event from UI
- Saves categorization with source='manual'
- Updates stats and sends tracking event

**retryReviewCategorization** - User-triggered retry
- Trigger: `review/retry.requested` event from UI
- Calls LLM with fresh context
- High confidence → auto-resolves with source='retry_auto'
- Low confidence → updates suggestion only

**trackRunCompletion** - Batched completion detector
- Listens to categorized/review/failed events
- Batches 100 events per 5 seconds
- Updates run status when all expenses processed
- No race conditions

## Project Structure

```
src/
├── types.ts              # TypeScript definitions
├── categories.ts         # Category hierarchy
├── db.ts                 # DuckDB connection
├── db-operations.ts      # CRUD operations + migrations
├── llm.ts                # Ollama integration
├── eval.ts               # Statistics utilities
├── logger.ts             # Pino configuration
├── app.ts                # HTTP server + routes
├── handlers/
│   ├── categories.ts     # Category endpoints
│   ├── categorizations.ts # Annotation endpoints
│   ├── csv-processing.ts # CSV upload
│   ├── expenses.ts       # Expense retrieval
│   ├── review.ts         # Review queue + splitting
│   ├── runs.ts           # Workflow run listing
│   └── stats.ts          # Statistics + comparison
└── inngest/
    ├── client.ts         # Inngest client
    ├── types.ts          # Event type definitions
    ├── processExpenses.ts    # Parent orchestrator
    ├── categorizeExpense.ts  # Per-expense worker
    ├── completeReviewedExpense.ts  # Human resolution
    ├── retryReviewCategorization.ts # Manual retry
    └── trackRunCompletion.ts       # Batched completion

public/
├── review.html          # Review queue UI
└── review-detail.html   # Individual review + Amazon splitting
```

## Configuration

**Environment Variables:**
```bash
FINNA_DB_PATH=./expenses.duckdb  # Database file
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1
DEBUG=1  # Debug logs
```

**Throttling (in categorizeExpense.ts):**
```typescript
throttle: {
  limit: 2,        // Concurrent requests
  period: '15s',   // Time window
  key: 'event.data.runId',  // Per-run isolation
}
```

Adjust based on hardware:
- Weak: `limit: 1, period: '20s'` (~3/min)
- Default: `limit: 2, period: '15s'` (~8/min)
- Fast: `limit: 5, period: '10s'` (~30/min)

## Review UI Features

- Displays all original CSV columns (Category, Address, Reference, etc.)
- Amazon integration: paste JSON from `parse-amazon.js` to auto-split
- Real-time validation for split transactions
- Search/filter categories with autocomplete
- Create new subcategories on the fly
- Warning badges for LLM failures

## Database Schema

**Tables:**
- `workflow_runs` - Batch metadata with status tracking
- `expenses_<runId>` - Per-run expense tables (all CSV columns + normalized fields)
- `categorizations` - Approved categorizations with source tracking
- `review_queue` - Items awaiting human review
- `categories` - Hierarchical category tree

**Key Fields:**
- `WorkflowRun.failedCount` - Count of LLM failures
- `Categorization.categorizationSource` - Track auto/manual/retry_auto
- `ReviewQueueItem.reason` - Why it needs review (low_confidence, llm_failure, etc.)

## Gotchas

**Model Selection:**
- Use: `llama3.1`, `qwen2.5:7b`, `qwen3`
- Avoid: Reasoning models like `deepseek-r1` (break JSON)

**BigInt Serialization:**
- DuckDB returns BigInt, use `safeJsonStringify()` helper in handlers

**Negative Filtering:**
- Bill payments (negative charges) auto-filtered during ingestion

**Sub-expenses:**
- Split transactions validated (amounts must sum to parent)
- Sub-expenses excluded from top-level categorization

**Graceful Duplicates:**
- Review queue: INSERT OR IGNORE
- Categorizations: INSERT OR REPLACE
