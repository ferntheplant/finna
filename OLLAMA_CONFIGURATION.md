# Ollama Configuration for Better Timeout Handling

## Client-Side Settings (Already Implemented)

✅ **HTTP timeout:** 5 minutes (300,000ms) in `src/llm.ts`
✅ **Retry logic:** Timeout errors now trigger Inngest's automatic retries with exponential backoff
✅ **Throttling:** Only 2 concurrent requests per 15 seconds to avoid overwhelming Ollama

## Ollama Server-Side Configurations

### Environment Variables

You can set these in your shell or `.env` file before starting Ollama:

```bash
# Increase Ollama's request timeout (default is 5 minutes)
export OLLAMA_KEEP_ALIVE=30m          # Keep model in memory for 30 minutes
export OLLAMA_MAX_LOADED_MODELS=1    # Only load one model at a time (saves memory)
export OLLAMA_NUM_PARALLEL=1         # Process only 1 request at a time (more stable)
export OLLAMA_MAX_QUEUE=100          # Queue up to 100 requests

# Optional: Limit concurrent requests (if your hardware struggles)
export OLLAMA_ORIGINS="http://localhost:*"  # Restrict who can call the API
```

### Model-Specific Settings

When you load a model, you can adjust these parameters in your Modelfile or via API:

```bash
# Via command line when pulling/running a model
ollama run llama3.1 \
  --num-thread 4 \       # Number of CPU threads (lower = less resource intensive)
  --num-ctx 2048 \       # Context window size (lower = faster, less memory)
  --num-gpu 0            # Disable GPU if causing issues (CPU only)
```

### Modelfile Example

Create a `Modelfile` to customize your model:

```dockerfile
FROM llama3.1

# Reduce context size for faster inference
PARAMETER num_ctx 2048

# Lower thread count if CPU is struggling
PARAMETER num_thread 4

# Keep model loaded longer
PARAMETER num_keep 1024

# Temperature for consistent categorization (already set in code)
PARAMETER temperature 0.1
```

Then create the custom model:
```bash
ollama create llama3.1-fast -f Modelfile
```

Update your `.env`:
```bash
OLLAMA_MODEL=llama3.1-fast
```

## Recommended Settings for Low-End Hardware

```bash
# ~/.ollama/config (create this file)
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_KEEP_ALIVE=10m
```

Then use a lightweight model:
```bash
ollama pull qwen2.5:3b     # 3 billion parameter model (much faster)
# or
ollama pull phi3:mini      # Microsoft's efficient 3B model
```

Update `.env`:
```bash
OLLAMA_MODEL=qwen2.5:3b
```

## Monitoring Ollama

Check if Ollama is the bottleneck:

```bash
# Watch Ollama logs
ollama logs

# Check running models
ollama list

# Monitor system resources
htop  # or Activity Monitor on Mac
```

## Debugging Timeouts

### 1. Check Ollama is running
```bash
curl http://localhost:11434/api/tags
```

### 2. Test model directly
```bash
time ollama run llama3.1 "Categorize this expense: $50 at Starbucks"
```
If this takes >30 seconds, your hardware may be too slow for the model.

### 3. Check system resources
- **CPU:** Should have spare capacity (not at 100%)
- **RAM:** Should have at least 8GB free for llama3.1
- **Disk:** Model needs to be on fast storage (SSD, not HDD)

## Troubleshooting Common Issues

### Issue: "Connection timeout" after 5 minutes
**Cause:** Model is too slow for your hardware
**Solution:**
1. Use a smaller model (qwen2.5:3b, phi3:mini)
2. Reduce `num_ctx` to 1024 or lower
3. Increase throttling to 1 per 30 seconds in categorizeExpense.ts

### Issue: "Too many requests" or Ollama crashes
**Cause:** Too many concurrent requests
**Solution:**
1. Set `OLLAMA_NUM_PARALLEL=1`
2. Reduce throttling to 1 per 20-30 seconds
3. Ensure `OLLAMA_MAX_LOADED_MODELS=1`

### Issue: Model keeps unloading between requests
**Cause:** `OLLAMA_KEEP_ALIVE` too short
**Solution:**
```bash
export OLLAMA_KEEP_ALIVE=30m  # or "always" to never unload
```

### Issue: First request after idle takes 30+ seconds
**Cause:** Model needs to load into memory
**Solution:**
1. Set `OLLAMA_KEEP_ALIVE=always`
2. Or "warm up" the model before batch: `ollama run llama3.1 "test"`

## Performance Expectations

| Model | Hardware | Speed per Expense |
|-------|----------|-------------------|
| llama3.1 (8B) | M1 Mac | 5-10 seconds |
| llama3.1 (8B) | Intel i7 | 10-20 seconds |
| qwen2.5:3b | M1 Mac | 2-5 seconds |
| qwen2.5:3b | Intel i7 | 5-10 seconds |
| phi3:mini | M1 Mac | 2-5 seconds |
| phi3:mini | Intel i7 | 5-10 seconds |

**Current throttle setting:** 2 per 15s = ~8 per minute

## Recommended Configuration Changes

After implementing the above, you can consider speeding up throttling:

```typescript
// In categorizeExpense.ts - if timeouts stop happening
throttle: {
  limit: 3,
  period: '15s',  // = 12 per minute
}
```

Or even back to original:
```typescript
throttle: {
  limit: 5,
  period: '10s',  // = 30 per minute
}
```

## Additional Resources

- [Ollama Environment Variables](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-configure-ollama)
- [Ollama API Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Modelfile Syntax](https://github.com/ollama/ollama/blob/main/docs/modelfile.md)

