import { serve } from "inngest/bun";
import { functions, inngest } from "./inngest";
import { initializeTables } from "./db-operations";
import { createLogger } from "./logger";
import {
  handleProcessCsv,
  handleGetRuns,
  handleGetRun,
  handleGetExpenses,
  handleGetCategories,
  handleCreateCategory,
  handleGetReviewQueue,
  handleGetReviewItem,
  handleCategorizeReview,
  handleRetryReview,
  handleGetStats,
  handleGetUncategorized,
  handleCompareRuns,
  handleUpdateAnnotation,
  handleGetCategorization,
} from "./handlers";

const logger = createLogger('app');

// Initialize database tables on startup
await initializeTables();
logger.info('Database tables initialized');

logger.info({
  port: 6969,
  inngestClientId: 'finna-expense-app',
  inngestEndpoint: 'http://localhost:6969/api/inngest',
  functionCount: functions.length,
  functions: functions.map(f => f.id),
}, 'Starting Finna Expense Categorization Server');

export const server = Bun.serve({
  port: 6969,
  async fetch(request: Request) {
    const url = new URL(request.url);

    // Inngest endpoint
    if (url.pathname === "/api/inngest") {
      const serveOptions = {
        client: inngest,
        functions,
        ...(process.env.INNGEST_SIGNING_KEY && {
          signingKey: process.env.INNGEST_SIGNING_KEY,
        }),
        ...(process.env.INNGEST_SERVE_PATH && {
          servePath: process.env.INNGEST_SERVE_PATH,
        }),
      };

      return await serve(serveOptions)(request);
    }

    // Process CSV endpoint
    if (url.pathname === "/api/process-csv" && request.method === "POST") {
      return handleProcessCsv(request);
    }

    // Workflow runs
    if (url.pathname === "/api/runs" && request.method === "GET") {
      return handleGetRuns();
    }

    if (url.pathname.match(/^\/api\/runs\/[^/]+$/) && request.method === "GET") {
      const runId = url.pathname.split("/").pop()!;
      return handleGetRun(runId);
    }

    // Expenses
    if (url.pathname.match(/^\/api\/expenses\/[^/]+$/) && request.method === "GET") {
      const runId = url.pathname.split("/").pop()!;
      return handleGetExpenses(runId);
    }

    // Categories
    if (url.pathname === "/api/categories" && request.method === "GET") {
      return handleGetCategories();
    }

    if (url.pathname === "/api/categories" && request.method === "POST") {
      return handleCreateCategory(request);
    }

    // Categorizations
    if (url.pathname.match(/^\/api\/categorizations\/[^/]+$/) && request.method === "GET") {
      const expenseId = url.pathname.split("/").pop()!;
      return handleGetCategorization(expenseId);
    }

    if (url.pathname.match(/^\/api\/categorizations\/[^/]+\/annotation$/) && request.method === "PATCH") {
      const pathParts = url.pathname.split("/");
      const expenseId = pathParts[3];
      if (!expenseId) {
        return new Response(JSON.stringify({ error: "Invalid expense ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleUpdateAnnotation(expenseId, request);
    }

    // Review queue
    if (url.pathname === "/api/review-queue" && request.method === "GET") {
      const runId = url.searchParams.get("runId") || undefined;
      return handleGetReviewQueue(runId);
    }

    if (url.pathname.match(/^\/api\/review-queue\/[^/]+$/) && request.method === "GET") {
      const id = url.pathname.split("/").pop()!;
      return handleGetReviewItem(id);
    }

    if (url.pathname.match(/^\/api\/review\/[^/]+\/categorize$/) && request.method === "POST") {
      const pathParts = url.pathname.split("/");
      const id = pathParts[3];
      if (!id) {
        return new Response(JSON.stringify({ error: "Invalid review ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleCategorizeReview(id, request);
    }

    if (url.pathname.match(/^\/api\/review\/[^/]+\/retry$/) && request.method === "POST") {
      const pathParts = url.pathname.split("/");
      const id = pathParts[3];
      if (!id) {
        return new Response(JSON.stringify({ error: "Invalid review ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return handleRetryReview(id);
    }

    // Stats and evaluation
    if (url.pathname.match(/^\/api\/stats\/[^/]+$/) && request.method === "GET") {
      const runId = url.pathname.split("/").pop()!;
      return handleGetStats(runId);
    }

    if (url.pathname.match(/^\/api\/uncategorized\/[^/]+$/) && request.method === "GET") {
      const runId = url.pathname.split("/").pop()!;
      return handleGetUncategorized(runId);
    }

    if (url.pathname === "/api/compare-runs" && request.method === "GET") {
      const runId1 = url.searchParams.get("run1");
      const runId2 = url.searchParams.get("run2");

      if (!runId1 || !runId2) {
        return new Response(JSON.stringify({
          error: "run1 and run2 query parameters required"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      return handleCompareRuns(runId1, runId2);
    }

    // UI pages
    if (url.pathname === "/review") {
      const file = Bun.file("public/review.html");
      return new Response(file);
    }

    if (url.pathname.match(/^\/review\/[^/]+$/)) {
      const file = Bun.file("public/review-detail.html");
      return new Response(file);
    }

    // Home
    if (url.pathname === "/") {
      return new Response("Finna Expense Categorization Server\n\nEndpoints:\n" +
        "- POST /api/process-csv - Start processing a CSV file\n" +
        "- GET /api/runs - List all workflow runs\n" +
        "- GET /api/expenses/:runId - Get expenses for a run\n" +
        "- GET /api/categories - Get all categories\n" +
        "- POST /api/categories - Create a new category\n" +
        "- GET /api/review-queue - Get pending review items\n" +
        "- GET /review - Review UI\n" +
        "- GET /api/stats/:runId - Get run statistics\n" +
        "- GET /api/uncategorized/:runId - Get uncategorized expenses\n" +
        "- GET /api/compare-runs?run1=X&run2=Y - Compare two runs\n"
      );
    }

    return new Response("Not found", { status: 404 });
  },
});
