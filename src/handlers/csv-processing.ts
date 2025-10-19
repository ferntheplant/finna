import { inngest } from '../inngest';
import { createLogger } from '../logger';

const logger = createLogger('handlers:csv');

export async function handleProcessCsv(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { filePath, csvType, runId } = body;

    logger.info({ filePath, csvType, runId }, 'Received process-csv request');

    if (!filePath || !csvType) {
      logger.error({ filePath, csvType }, 'Missing required fields');
      return new Response(JSON.stringify({ error: "filePath and csvType required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const actualRunId = runId || `run_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.debug({ actualRunId }, 'Generated runId');

    logger.debug({
      eventName: 'expenses/processing.started',
      runId: actualRunId,
      filePath,
      csvType
    }, 'Sending event to Inngest');

    const sendResult = await inngest.send({
      name: "expenses/processing.started",
      data: {
        runId: actualRunId,
        filePath,
        csvType,
      },
    });

    logger.info({ sendResult }, 'Event sent to Inngest successfully');

    return new Response(JSON.stringify({
      runId: actualRunId,
      message: "Processing started"
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.error({ error }, 'Error processing CSV request');
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

