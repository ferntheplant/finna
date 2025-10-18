# finna

A quick way to categorize expenses in a flexible heirarchy.

## Project Description

GOAL: take a bunch of CSV files of my expenses and assign each a category

REQUIREMENTS:
- categories descend from the `ROOT_CATEGORIES` in `./src/categories.ts`
- use LLMs to take a line item and decide if an existing category from the heirarchy fits or if a new one should be created
- give LLMs to option to make web queries for the Merchant of Record to get extra context
- allow for human-in-the-loop review for expenses whose (sub)category cannot be confidently determined by the LLM
- obfuscated expense items like `Amazon` or `Venmo` should be sent to the human-in-the-loop flow for me to manually give a description of the actual item that was purchased

Note: the CSV files come in 2 types: credit card

```csv
Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category
09/19/2025,AplPay 123 ST 89 AVE Brooklyn            NY,11.00,"3Rwdk7r4 squareup.com/receipts
AplPay 123 ST 89 AVE
Brooklyn
NY
squareup.com/receipts",AplPay 123 ST 89 AVE Brooklyn            NY,45 TH ST,"NEW YORK
NY",10001,UNITED STATES,'1234567891011',Restaurant-Bar & Café
```

and bank statement

```csv
Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,08/21/2025,"SOME MERCHANTOFRECORD                     PPD ID: 1234567890",55.64,ACH_CREDIT,2000.50,,
```

The credit card CSV files have various new line characters for the `address` column which may make parsing difficult.

## Tech Setup

### Bun HTTP Server

The project runs on Bun as a basic HTTP web server. The expense CSV files will live on the same host as the HTTP server and so can be read directly from disk as needed. The HTTP server exists mainly as a scaffold for Inngest (see below). The actual expense processing workflows can be kicked off by a simple HTTP endpoint that provides the file names/path and maybe an idempotency key.

### Inngest

We use [Inngest](https://www.inngest.com/) as a durable workflow engine to make human-in-the-loop review easy to implement. Inngest provides ergonomic idioms for pausing a workflow and throttling resource-heavy functions - especially useful for AI deployments.

The Inngest workflows run directly on an HTTP server so each step in the workflow can have access to shared resources like database connections.

### Duckdb

We use DuckDB as the ACID compliant database for the project. The Bun HTTP server can read the base `expenses.duckdb` file from disk and give workflow handlers access to the DuckDB connection object. The DuckDB client gives basic transactional guarantees so concurrent workflow steps can read from and write to the database without issue.

One advantage of DuckDB is the lack of formal schema. We can simply load the CSV directly into a DuckDB table and write outputs to new tables without a worrying about migrations. This also gives us flexibility in separating different workflow runs and versions so we can see how different prompts or models lead to different final categorizations.

### Ollama

The LLMs used to categorize expenses will actually run locally as well via Ollama and thus be accessible using the `ollama` SDK. This does mean that these AI requests may be extra slow as the local host will not have the same compute resources as cloud offerings.

It also means that the models being used will be less powerful though that shouldn't be an issue for the simple task of categorizing transactions.
