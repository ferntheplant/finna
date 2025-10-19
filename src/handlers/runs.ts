import { getAllWorkflowRuns, getWorkflowRun } from '../db-operations';

export async function handleGetRuns(): Promise<Response> {
  const runs = await getAllWorkflowRuns();
  return new Response(JSON.stringify(runs), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleGetRun(runId: string): Promise<Response> {
  const run = await getWorkflowRun(runId);

  if (!run) {
    return new Response(JSON.stringify({ error: "Run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(run), {
    headers: { "Content-Type": "application/json" },
  });
}

