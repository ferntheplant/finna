# finna

Automated expense categorization using local LLMs with human-in-the-loop review.

## What It Does

- Parses CSV exports from credit cards and bank statements
- Uses Ollama (local LLM) to categorize expenses into a flexible hierarchy
- Flags low-confidence items for human review
- Supports splitting transactions (e.g., Amazon orders into individual items)
- Automatically filters out bill payments (negative charges)

## Quick Start

```bash
# Install dependencies
bun install

# Start Ollama
ollama serve
ollama pull llama3.1

# Start Inngest dev server (separate terminal)
bunx inngest-cli@latest dev

# Start the app
bun run dev

# Process a CSV
curl -X POST http://localhost:6969/api/process-csv \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/expenses.csv", "csvType": "credit_card"}'

# Review flagged items
open http://localhost:6969/review
```

## Requirements

- **Bun** (runtime)
- **Ollama** running locally
- **CSV files** from credit cards or bank statements

### Supported CSV Formats

**Credit Card:**
```
Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
```

**Bank Statement:**
```
Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
```

## Tech Stack

- **Bun** - HTTP server and runtime
- **Inngest** - Durable workflows with human-in-the-loop
- **DuckDB** - Embedded database (ACID, no migrations)
- **Ollama** - Local LLM inference
- **Pino** - Structured logging

## Configuration

Copy `.env.example` to `.env`:

```bash
# Database
FINNA_DB_PATH=./expenses.duckdb  # default: :memory:

# Ollama
OLLAMA_MODEL=llama3.1            # Recommended: llama3.1, qwen2.5:7b
OLLAMA_HOST=http://localhost:11434

# Logging
DEBUG=1  # Enable debug logs (default: 0)
```

## Architecture

```
CSV Upload → Inngest Workflow
  ↓
Parse & Store in DuckDB
  ↓
Trigger Categorization (throttled: 2 per 15s)
  ├─→ High confidence (≥0.7) → Save categorization
  ├─→ Low confidence → Add to review queue
  └─→ LLM failure → Add to review queue with special flag
  ↓
Human reviews flagged items
  ↓
Workflow completes when all categorized or queued
```

**Key Design Decisions:**

- **Stable IDs**: Content-based hashing (MD5 of Date+Description+Amount+Merchant) prevents duplicates across re-imports
- **Raw data preservation**: All original CSV columns stored and displayed in review UI
- **Table-per-run**: Each CSV import gets isolated expense table for easy comparison
- **Event-driven completion**: Workflows complete immediately, no blocking waits
- **Throttling**: Max 2 LLM calls per 15 seconds protects local Ollama (configurable in `src/inngest/categorizeExpense.ts`)

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for implementation details.

## Key Features

### Transaction Splitting

Split a single charge into multiple sub-expenses:

```bash
curl -X POST http://localhost:6969/api/review/{id}/categorize \
  -H "Content-Type: application/json" \
  -d '{
    "splitTransaction": [
      {"description": "Item 1", "amount": 75.50},
      {"description": "Item 2", "amount": 24.50}
    ]
  }'
```

### Amazon Integration

For Amazon purchases, paste JSON from `parse-amazon.js` (browser console script) directly in the review UI to auto-split by item.

### Annotations

Add manual notes to categorized expenses that the LLM will see when categorizing similar future expenses:

```bash
PATCH /api/categorizations/{expenseId}/annotation
{"annotation": "Work expense for client meeting"}
```

## Important Gotchas

### LLM Model Selection

**Use these models:**
- `llama3.1` - Good balance (default)
- `qwen2.5:7b` - Fast and reliable
- `qwen3` - Excellent JSON formatting

**Avoid reasoning models:**
- ⚠️ `deepseek-r1` and similar break JSON output with thinking process

### Performance Tuning

Default throttling: 2 concurrent LLM calls per 15 seconds (~8/min, ~480/hour).

If LLM timeouts occur, reduce concurrency in `src/inngest/categorizeExpense.ts`:
```typescript
throttle: {
  limit: 1,        // Only 1 at a time
  period: '20s',   // Space them further apart
}
```

If your hardware is fast, increase for better throughput:
```typescript
throttle: {
  limit: 5,
  period: '10s',   // ~30 per minute
}
```

### DuckDB BigInt Serialization

DuckDB returns BigInt values. API handlers use `safeJsonStringify()` to convert to Number before JSON.stringify.

### Inngest Dashboard

For local dev: `bunx inngest-cli@latest dev` (dashboard at http://localhost:8288)

For self-hosted Docker, see [docs/DOCKER_SETUP.md](./docs/DOCKER_SETUP.md).

## API Endpoints

**Processing:**
- `POST /api/process-csv` - Start processing
- `GET /api/runs` - List workflow runs
- `GET /api/expenses/:runId` - Get expenses with categorizations

**Review:**
- `GET /api/review-queue` - Get pending items
- `POST /api/review/:id/categorize` - Resolve item (supports splitting)

**Categories:**
- `GET /api/categories` - List all
- `POST /api/categories` - Create new

**Evaluation:**
- `GET /api/stats/:runId` - Statistics
- `GET /api/uncategorized/:runId` - Find uncategorized
- `GET /api/compare-runs?run1=X&run2=Y` - Compare runs

## Troubleshooting

**Ollama connection errors:**
- Ensure `ollama serve` is running
- Check `OLLAMA_HOST` in `.env`

**JSON parsing errors from LLM:**
- Switch to recommended model: `llama3.1` or `qwen2.5:7b`
- Check `logs/app.log` for actual LLM response

**Workflows hanging:**
- Verify Inngest dev server is running
- Check dashboard at http://localhost:8288 for stuck steps
- Ensure functions are registered (should show 5 functions)

**DuckDB errors:**
- Check file permissions if using persistent storage
- Ensure `FINNA_DB_PATH` directory exists

## Logging

Logs written to:
- `logs/app.log` - Structured JSON for searching
- stdout - Pretty-printed for terminal

Enable debug logs: `DEBUG=1 bun run dev`

Search logs:
```bash
grep '"level":50' logs/app.log | jq  # Errors only
grep 'run_123' logs/app.log | jq     # Specific run
```

See [docs/LOGGING.md](./docs/LOGGING.md) for details.
