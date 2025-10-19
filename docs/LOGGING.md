# Logging

The application uses [Pino](https://getpino.io/) for structured logging with dual output:
- **JSON logs** to `logs/app.log` for searching and analysis
- **Pretty-printed logs** to stdout for development

## Configuration

Enable debug logs by setting the `DEBUG` environment variable:

```bash
DEBUG=1 bun run dev
```

Default log level is `info` when `DEBUG` is not set.

## Log Levels

- **debug**: Detailed diagnostic information (only shown when `DEBUG=1`)
- **info**: General informational messages
- **warn**: Warning conditions that don't prevent operation
- **error**: Error conditions with stack traces

## Usage

### In Application Code

```typescript
import { createLogger } from './logger';

const logger = createLogger('component-name');

logger.info({ userId: 123 }, 'User logged in');
logger.error({ error, stack }, 'Failed to process request');
logger.debug({ data }, 'Processing intermediate result');
```

### In Inngest Workflows

Inngest provides a logger parameter that automatically includes workflow context:

```typescript
inngest.createFunction(
  { id: 'my-function' },
  { event: 'my/event' },
  async ({ event, step, logger }) => {
    logger.info('Starting workflow', { runId: event.data.runId });
    // Inngest logger automatically adds function name, event name, and run ID
  }
);
```

The application's Pino logger is configured to work with Inngest's logging middleware, providing consistent logging across both application code and workflows. See [Inngest logging docs](https://www.inngest.com/docs/guides/logging) for more details.

## Log File Location

Logs are written to `logs/app.log` and automatically rotated by the filesystem. The `logs/` directory is created automatically on first run and is excluded from git.

## Searching Logs

Since logs are structured JSON, you can easily search them:

```bash
# Find all errors
grep '"level":50' logs/app.log | jq

# Find logs for specific run
grep 'run_123' logs/app.log | jq

# View logs with specific component
grep '"component":"app"' logs/app.log | jq .msg
```

## Architecture

- `src/logger.ts` - Centralized logger configuration
- Component loggers created via `createLogger('component-name')`
- Inngest workflows use the provided `logger` parameter
- LLM function accepts optional logger parameter for flexibility

