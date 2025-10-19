# Architecture

## Tech Stack

**Bun** - HTTP server and runtime
**Inngest** - Durable workflow engine for human-in-the-loop
**DuckDB** - ACID-compliant embedded database
**Ollama** - Local LLM inference
**Pino** - Structured logging with JSON file output and pretty console output

## Data Flow

```
CSV File → POST /api/process-csv
  ↓
Inngest: processExpenses workflow
  ├─ Ingest CSV → DuckDB table (expenses_<runId>)
  │   └─ Generate stable IDs: md5(Date+Description+Amount+Merchant)
  │   └─ Store all CSV columns (rawData) + normalized fields
  ├─ Trigger categorizeExpense for each expense
  │     ↓
  │   categorizeExpense workflow
  │     ├─ Fetch expense & categories
  │     ├─ Call Ollama LLM (includes CSV Category field)
  │     ├─ Update stats (categorizedCount/reviewQueueCount)
  │     ├─ High confidence (≥0.7) → Save categorization
  │     └─ Low confidence → Add to review queue → step.waitForEvent()
  │          ↓
  │        Human reviews at /review UI (sees raw CSV data)
  │          ↓
  │        POST /api/review/:id/categorize
  │          ↓
  │        Send 'review/item.resolved' event
  │          ↓
  │        Workflow resumes & saves categorization
  │          ↓
  │        Update stats & check completion
  │
  └─ step.waitForEvent('expenses/processing.completed')
       ↓
     All categorizations done! Workflow completes immediately
```

## Key Design Decisions

**Stable Expense IDs**: Content-based hashing (MD5 of Date+Description+Amount+Merchant) ensures:
- Same expense always gets same ID
- Re-imports update existing categorizations (INSERT OR REPLACE)
- No duplicate categorizations across multiple runs

**Raw Data Preservation**:
- Keep all original CSV columns using `SELECT * EXCLUDE (...)`
- Store normalized fields separately (date, amount, description)
- Display raw data in review UI for human context
- LLM receives CSV Category field for better accuracy

**Table-per-run**: Each processing run gets its own expense table for isolation and easy comparison

**Event-driven completion**:
- Track progress with categorizedCount + reviewQueueCount
- Send `expenses/processing.completed` when all done
- Main workflow uses `step.waitForEvent()` instead of arbitrary sleep
- Completes immediately (not after 1-hour timeout!)

**Structured LLM output**:
- Request JSON format from Ollama
- Extract JSON from markdown code blocks
- Handle BigInt serialization (DuckDB → JSON)
- Model recommendations: llama3.1, qwen3 (avoid reasoning models)

**Confidence threshold**: 0.7 balances automation vs. accuracy

**Throttling**: Max 5 expenses per 10 seconds protects local Ollama

**Sub-expenses**: Transactions can be split with automatic validation (amounts must sum to parent)

**Graceful duplicate handling**:
- Review queue: INSERT OR IGNORE (silently skip duplicates)
- Categorizations: INSERT OR REPLACE (update in place)

**Negative filtering**: Bill payments (negative charges) automatically excluded during ingestion

## Review UI Features

The review interface (`/review-detail/{id}`) provides:

**Original CSV Data Display**:
- Shows all raw CSV columns (Category, Address, Reference, etc.)
- Fields sorted by importance (Category, Address, Reference first)
- Category field highlighted in blue and bold
- Helps identify unclear transactions

**Amazon Integration**:
- Automatically shows "🛒 Split Amazon Purchase" for Amazon expenses
- Paste JSON directly from `parse-amazon.js` browser script
- Real-time validation and preview
- Shows item breakdown and charge summary
- Validates amounts match expense total
- Warns about shipping/tax distribution

**Category Selection**:
- Search/filter existing categories
- Create new subcategories on the fly
- Shows full category path for clarity

## Project Structure

```
src/
├── types.ts              # TypeScript type definitions
├── categories.ts         # Category hierarchy
├── db.ts                 # DuckDB connection
├── db-operations.ts      # Database CRUD operations
├── llm.ts                # Ollama LLM integration
├── eval.ts               # Statistics and comparison utilities
├── app.ts                # HTTP server and API endpoints
├── handlers/
│   ├── categories.ts     # Category API handlers
│   ├── csv-processing.ts # CSV upload handlers
│   ├── expenses.ts       # Expense API handlers
│   └── review.ts         # Review queue handlers (with BigInt fix)
└── inngest/
    ├── client.ts         # Inngest client configuration
    ├── types.ts          # Event type definitions
    ├── processExpenses.ts    # Main CSV processing workflow
    └── categorizeExpense.ts  # Individual expense categorization

public/
├── index.html           # Main dashboard
├── review.html          # Review queue list
└── review-detail.html   # Individual review UI (Amazon support)
```

## Configuration

```bash
FINNA_DB_PATH=./expenses.duckdb  # default: :memory:
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1            # Recommended: llama3.1, qwen3, qwen2.5:7b
DEBUG=1  # Enable debug logs (default: 0)
```

**Model Notes**:
- Use models optimized for JSON output (llama3.1, qwen3)
- Avoid reasoning models (deepseek-r1) - they break JSON with thinking process
- Set `think: false` in ollama.chat() options for reasoning models

See [LOGGING.md](./LOGGING.md) for logging details.

