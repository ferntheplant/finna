# Docker Setup for Inngest

## Quick Start (Recommended: Use Dev Server Instead)

For local development, the Inngest CLI dev server is simpler:

```bash
bunx inngest-cli@latest dev
```

Visit `http://localhost:8288` for the dashboard. No Docker or configuration needed.

## Self-Hosted Docker Setup

If you prefer Docker, you need to tell Inngest where your app is:

### 1. Set Environment Variables

```bash
export INNGEST_DEV=0  # Required for self-hosted
export INNGEST_EVENT_KEY=your-event-key
export INNGEST_SIGNING_KEY=your-signing-key
export INNGEST_BASE_URL=http://localhost:8288
```

### 2. Start Inngest with SDK URL

```bash
docker run -p 8288:8288 -p 8289:8289 inngest/inngest \
  inngest start \
  --event-key your-event-key \
  --signing-key your-signing-key \
  --sdk-url http://host.docker.internal:6969/api/inngest \
  --poll-interval 60
```

**Key flags:**
- `--sdk-url` tells Inngest where to find your functions
- `--poll-interval 60` checks for updates every 60 seconds
- Use `host.docker.internal` on Mac/Windows, or your machine's IP on Linux

### 3. Verify

Check the dashboard at `http://localhost:8288`:
- **Apps** should show `finna-expense-app`
- **Functions** should show 3 functions

## Troubleshooting

**Functions not showing?**
```bash
# Test if Inngest can reach your app
docker exec -it <inngest-container> curl http://host.docker.internal:6969/api/inngest

# If that fails, use your machine's IP instead
ipconfig getifaddr en0  # Mac
```

**Events sent but no runs?**
Functions aren't registered. Verify Inngest can reach `/api/inngest` endpoint.
