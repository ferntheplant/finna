import { serve } from "inngest/bun";
import { functions, inngest } from "./inngest";

export const server = Bun.serve({
  port: 6969,
  routes: {
    "/": async _ => {
      await inngest.send({
        name: "demo/event.sent",
        data: {
          message: "Message from Bun Server",
        },
      });
      return new Response("Hello man!");
    },
    "/api/inngest": (request: Request) => {
      return serve({ client: inngest, functions })(request);
    },
  },
});
