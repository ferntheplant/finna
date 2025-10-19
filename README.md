# finna

Categorize expenses from CSV files using local LLMs with human-in-the-loop review.

## What It Does

- Reads credit card and bank statement CSVs
- Uses Ollama (local LLM) to categorize expenses into a flexible hierarchy
- Flags low-confidence items for human review
- Supports splitting transactions (e.g., Amazon orders into individual items)
- Automatically filters out bill payments (negative charges)

## Quick Start

```bash
# Install dependencies
bun install

# Start Ollama and pull a model
ollama serve
ollama pull llama3.1

# Start Inngest dev server (in separate terminal)
bunx inngest-cli@latest dev

# Start the app
bun run dev

# Process a CSV
curl -X POST http://localhost:6969/api/process-csv \
  -H "Content-Type: application/json" \
  -d '{
    "filePath": "/path/to/expenses.csv",
    "csvType": "credit_card"
  }'

# Review flagged expenses
open http://localhost:6969/review
```

## CSV Formats

**Credit Card:**
```csv
Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
09/19/2025,AplPay RESTAURANT NAME,11.00,...
```

**Bank Statement:**
```csv
Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,08/21/2025,MERCHANT NAME,55.64,ACH_CREDIT,2000.50,,
```

## Key Features

### Stable Expense IDs

Expense IDs are generated from content hashes (Date + Description + Amount + Merchant). This means:
- ✅ Same expense = same ID across multiple imports
- ✅ Re-importing a CSV updates existing categorizations instead of creating duplicates
- ✅ No duplicate entries in the categorizations table

### Raw CSV Data Preservation

All original CSV columns are preserved and displayed in the review UI:
- View Category field from credit card statements (very helpful for context!)
- See Address, Reference numbers, and other fields that help identify unclear transactions
- LLM uses the CSV Category field as additional context for better accuracy

### Transaction Splitting

Split a single transaction into multiple sub-expenses:

```bash
curl -X POST http://localhost:6969/api/review/{id}/categorize \
  -H "Content-Type: application/json" \
  -d '{
    "splitTransaction": [
      { "description": "Groceries", "amount": 75.50 },
      { "description": "Household items", "amount": 24.50 }
    ]
  }'
```

### Amazon Integration

For Amazon expenses flagged for review, you can paste the JSON data directly in the UI:

1. Run `parse-amazon.js` in browser console on Amazon order page
2. Copy the `purchasedItems` and `chargeSummary` JSON
3. In the review UI, click "🛒 Split Amazon Purchase"
4. Paste the JSON data
5. Review the preview and submit

**Or via API:**
```bash
curl -X POST http://localhost:6969/api/review/{id}/categorize \
  -H "Content-Type: application/json" \
  -d '{
    "amazonItems": [...],
    "amazonChargeSummary": [...]
  }'
```

The system automatically:
- Validates amounts match the expense total
- Adds shipping/taxes to the most expensive item
- Creates sub-expenses that get individually categorized

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
# Database
FINNA_DB_PATH=./expenses.duckdb  # default: :memory:

# Ollama
OLLAMA_MODEL=llama3.1            # default: llama3.1
OLLAMA_HOST=http://localhost:11434

# Logging
DEBUG=1  # Enable debug logs (default: 0)
```

**Recommended Models:**
- `llama3.1` - Good balance of speed and accuracy (default)
- `qwen3` - Excellent at JSON formatting
- `qwen2.5:7b` - Fast and reliable
- ⚠️ **Avoid** reasoning models like `deepseek-r1` - they break JSON output

Logs are written to:
- `logs/app.log` - Structured JSON for searching
- stdout - Pretty-printed for terminal viewing

## API Endpoints

**Processing:**
- `POST /api/process-csv` - Start processing a CSV file
- `GET /api/runs` - List all workflow runs
- `GET /api/expenses/:runId` - Get expenses with categorizations

**Review:**
- `GET /api/review-queue` - Get pending review items
- `POST /api/review/:id/categorize` - Resolve review item (supports splitting)

**Categories:**
- `GET /api/categories` - Get all categories
- `POST /api/categories` - Create a new category

**Evaluation:**
- `GET /api/stats/:runId` - Get categorization statistics
- `GET /api/uncategorized/:runId` - Find uncategorized expenses
- `GET /api/compare-runs?run1=X&run2=Y` - Compare two runs

## Tech Stack

- **Bun** - HTTP server
- **Inngest** - Durable workflows with human-in-the-loop support
- **DuckDB** - Embedded database (no migrations needed)
- **Ollama** - Local LLM inference

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for implementation details.

## Inngest Dashboard

For self-hosted Docker setup, see [docs/DOCKER_SETUP.md](./docs/DOCKER_SETUP.md).

For local development:
```bash
bunx inngest-cli@latest dev
# Dashboard at http://localhost:8288
```

## Troubleshooting

**Ollama connection errors**:
- Ensure Ollama is running (`ollama serve`)
- Check `OLLAMA_HOST` in your `.env`

**JSON parsing errors from LLM**:
- Switch to a recommended model: `export OLLAMA_MODEL=llama3.1`
- Avoid reasoning models like `deepseek-r1`
- Check `logs/app.log` for the actual LLM response

**BigInt serialization errors in review queue**:
- Fixed in latest version with `safeJsonStringify()` helper
- Converts BigInt to Number before JSON.stringify

**Duplicate categorizations**:
- Fixed with content-based hashing
- Re-importing same CSV now updates existing records

**Workflow hangs after categorization**:
- Fixed with event-driven completion
- Workflow completes immediately when all categorizations done
- Check Inngest dashboard for stuck steps

**Amount/description showing as empty in UI**:
- Fixed by excluding original CSV columns from raw data
- Normalized fields (date, amount, description) now work correctly

**DuckDB errors**:
- Check file permissions if using persistent storage
- Ensure `FINNA_DB_PATH` directory exists

**Inngest not processing**:
- Verify functions registered at `http://localhost:8288`
- Check Inngest dev server is running (`bunx inngest-cli@latest dev`)
