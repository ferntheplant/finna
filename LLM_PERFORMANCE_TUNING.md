# LLM Performance Tuning Guide

## Overview
The categorization system is now optimized for **local LLM hardware** with configurable throttling, generous retries, and automatic spacing of requests. You can process large batches without manual intervention - the system will just take longer to complete.

## Current Configuration

### Categorization Workflow (`src/inngest/categorizeExpense.ts`)

```typescript
throttle: {
  limit: 2,        // Only 2 concurrent LLM calls
  period: '15s',   // Per 15 second window
  key: 'event.data.runId',  // Per run (batches don't interfere)
}
retries: 5,        // Retry failed LLM calls up to 5 times
```

**Processing rate:** ~8 expenses per minute, ~480 per hour

### Retry Workflow (`src/inngest/retryReviewCategorization.ts`)

```typescript
retries: 5,  // 5 retry attempts with exponential backoff
```

### Batch Processing (`src/inngest/processExpenses.ts`)

```typescript
timeout: '12h',  // Wait up to 12 hours for batch completion
```

**Max batch capacity:** ~5,760 expenses in 12 hours at current throttle rate

## Tuning Options

### If LLM is still timing out:

**Option 1: Reduce concurrency (safest)**
```typescript
// In categorizeExpense.ts
throttle: {
  limit: 1,        // Only 1 at a time
  period: '20s',   // Space them 20 seconds apart
}
```
Rate: ~3 per minute, ~180 per hour

**Option 2: Increase period**
```typescript
throttle: {
  limit: 2,
  period: '30s',   // Give each one more time
}
```
Rate: ~4 per minute, ~240 per hour

### If LLM is fast and you want to speed up:

**Option 1: Increase concurrency**
```typescript
throttle: {
  limit: 3,        // 3 concurrent
  period: '15s',
}
```
Rate: ~12 per minute, ~720 per hour

**Option 2: Decrease period**
```typescript
throttle: {
  limit: 2,
  period: '10s',   // Faster cycling
}
```
Rate: ~12 per minute, ~720 per hour

**Option 3: Both!**
```typescript
throttle: {
  limit: 5,
  period: '10s',
}
```
Rate: ~30 per minute, ~1,800 per hour (original setting)

### Adjust batch timeout:

If you're processing huge batches (>5,000 expenses), increase the timeout:

```typescript
// In processExpenses.ts
timeout: '24h',  // 24 hours for very large batches
```

## How Throttling Works

Inngest's throttle feature automatically:
1. Queues all categorization events immediately
2. Processes them at the configured rate
3. Spreads the load evenly over time
4. Handles retries with exponential backoff

**Example with 100 expenses at current settings:**
- All 100 events sent immediately
- Processed at 2 per 15 seconds = 8 per minute
- Total time: ~12.5 minutes
- No manual intervention needed!

## Monitoring

Watch the logs for:
- `Throttling will space these at X per Y seconds` - confirms throttling is active
- `Retry X/5` - shows retry attempts
- `✓ Categorized` - successful completions
- `→ Review queue` - items needing human review

## Retries & Error Handling

According to [Inngest's error handling docs](https://www.inngest.com/docs/guides/error-handling), functions automatically retry with exponential backoff:

- Retry 1: immediately
- Retry 2: ~1 second
- Retry 3: ~2 seconds
- Retry 4: ~4 seconds
- Retry 5: ~8 seconds

This handles temporary issues like:
- Network timeouts
- Ollama temporarily busy
- Database locks
- Transient errors

## Best Practices

1. **Start conservative** - Use slower settings first, speed up after testing
2. **Monitor your hardware** - Watch CPU/RAM usage on your LLM server
3. **Batch processing is fine** - Upload large batches and let them process overnight
4. **Retries are good** - Don't disable them; they handle transient issues
5. **Trust the queue** - Inngest handles all the spacing automatically

## Troubleshooting

### "Still getting timeouts after 5 retries"
- Your LLM is truly overwhelmed
- Reduce `limit` to 1 or increase `period` to 30s+
- Check Ollama logs for issues

### "Processing too slow, batch won't finish in 12 hours"
- Increase `timeout` in processExpenses.ts
- Or speed up throttling if your hardware can handle it

### "Some expenses get categorized immediately, others wait"
- This is normal! Throttling spreads them over time
- Check logs for "Throttling will space these..." message

## Example Configurations

### Slow but reliable (weak hardware)
```typescript
limit: 1, period: '30s'  // 2 per minute, 120 per hour
timeout: '24h'           // Allow 24 hours for completion
```

### Balanced (current default)
```typescript
limit: 2, period: '15s'  // 8 per minute, 480 per hour
timeout: '12h'           // Allow 12 hours for completion
```

### Fast (powerful hardware)
```typescript
limit: 5, period: '10s'  // 30 per minute, 1,800 per hour
timeout: '6h'            // Allow 6 hours for completion
```

---

**Remember:** The system is designed for patience. Upload your batch and check back later - it will complete!

