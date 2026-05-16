# Mnueron — .NET / C# SDK

A single-file client for the mnueron memory backend at
<https://www.mnueron.com>. Drop `MnueronClient.cs` into any .NET 6+ project,
no NuGet package required (uses built-in `System.Net.Http.Json`).

Get a bearer token from `Settings → API Tokens` after signing up.

## Usage

```csharp
using Mnueron;

await using var client = new MnueronClient("mnu_xxxxxxxxxxxxxxxxxxxxx");

// Save a memory
var mem = await client.SaveAsync(
    content: "User prefers concise replies",
    @namespace: "my-app",
    tags: new[] { "preferences" });

// Full-text search (BM25 server-side)
foreach (var r in await client.SearchAsync(
             "how does the user like responses?",
             @namespace: "my-app", k: 5))
    Console.WriteLine($"{r.Content} (score: {r.Score})");

// Partial update — metadata MERGED (pass null in the dict to remove a key)
await client.UpdateAsync(mem.Id,
    tags: new[] { "preferences", "tone" },
    metadata: new Dictionary<string, object?> { ["confidence"] = 0.9 });

// Delete
await client.DeleteAsync(mem.Id);
```

## Date + metadata filters (v0.2.1 / v0.2.4)

Date arguments are epoch milliseconds. All filters stack.

```csharp
var since = DateTimeOffset.UtcNow.AddDays(-1).ToUnixTimeMilliseconds();
var recent = await client.ListAsync(
    @namespace: "my-app",
    createdAfter: since,
    metadataFilter: new Dictionary<string, object?> { ["speaker"] = "sarah" });
```

## Bulk search (v0.2.3)

Up to 25 queries in one HTTP round-trip:

```csharp
var bulk = await client.BulkSearchAsync(
    new[] { "onboarding", "billing edge cases", "JWT setup" },
    @namespace: "work", k: 5);

foreach (var r in bulk)
    Console.WriteLine($"{r.Query} → {r.Hits.Count} hits");
```

## Webhooks (v0.3.1)

Register an HTTPS endpoint to receive `memory.saved`, `memory.updated`,
`memory.deleted`, or `summary.created` events:

```csharp
var hook = await client.CreateWebhookAsync(
    url: "https://example.com/mnueron-hook",
    events: new[] { "memory.saved", "memory.deleted" },
    description: "forward saves into our event bus");

// Show the signing secret to the user ONCE — it isn't returned by Get/List.
Console.WriteLine($"Store this now: {hook.Secret}");
```

Verify signatures on incoming deliveries:

```csharp
[HttpPost("mnueron-hook")]
public async Task<IActionResult> Hook()
{
    using var ms = new MemoryStream();
    await Request.Body.CopyToAsync(ms);
    var body = ms.ToArray();
    var sig = Request.Headers["X-Mnueron-Signature"].ToString();

    if (!MnueronClient.VerifyWebhookSignature(_secret, body, sig))
        return Unauthorized();

    // ... handle the event payload (JSON in the body)
    return Ok();
}
```

## ASP.NET / dependency injection

```csharp
// Program.cs
builder.Services.AddSingleton(sp =>
    new MnueronClient(
        apiKey: builder.Configuration["Mnueron:ApiKey"]!));

// In a controller
public class ChatController : ControllerBase
{
    private readonly MnueronClient _mnueron;
    public ChatController(MnueronClient mnueron) => _mnueron = mnueron;

    [HttpPost("ask")]
    public async Task<IActionResult> Ask([FromBody] AskRequest req)
    {
        var context = await _mnueron.SearchAsync(
            req.Question,
            @namespace: $"user-{User.Identity!.Name}",
            k: 5);
        // ... pass context to your LLM call
        return Ok();
    }
}
```

## Configuration via env vars

```bash
export MNUERON_API_KEY=mnu_xxxxxxxxxxxxxxxxxxxxx
# Optional — default is https://www.mnueron.com
export MNUERON_API_URL=https://www.mnueron.com
```

```csharp
await using var client = new MnueronClient(); // picks up env vars
```

## API reference

| Method | Returns | Notes |
|---|---|---|
| `SaveAsync(content, @namespace, tags, source, sourceRef, metadata)` | `Memory` | Triggers redaction + fact extraction + `memory.saved` webhooks. |
| `SearchAsync(query, @namespace, k, createdAfter, …, metadataFilter)` | `IReadOnlyList<Memory>` | BM25 search with stacking filters. |
| `BulkSearchAsync(queries, …)` | `IReadOnlyList<BulkSearchResult>` | v0.2.3 — multi-query batch. |
| `ListAsync(@namespace, limit, offset, …)` | `IReadOnlyList<Memory>` | Newest-first list with date + metadata filters. |
| `GetAsync(memoryId)` | `Memory?` | Null on 404. |
| `UpdateAsync(memoryId, content, tags, @namespace, metadata)` | `Memory` | v0.2.2 partial update; metadata merged. |
| `DeleteAsync(memoryId)` | — | Fires `memory.deleted` webhook. |
| `NamespacesAsync()` | `IReadOnlyList<Namespace>` | Counts per namespace. |
| `HealthAsync()` | `bool` | Liveness probe. |
| `ListWebhooksAsync` / `CreateWebhookAsync` / `GetWebhookAsync` / `UpdateWebhookAsync` / `DeleteWebhookAsync` | — | v0.3.1 webhook management. |
| `VerifyWebhookSignature(secret, body, header)` | `bool` | Static constant-time HMAC-SHA256 check. |

All async methods throw `MnueronException(StatusCode, Message)` on
non-2xx responses and honor `CancellationToken`.

## Notes

- Wraps the exact same REST API as the Python SDK and the MCP server. Mix and match clients freely.
- For .NET Framework 4.8 or older, swap `System.Net.Http.Json` for manual `JsonSerializer.Serialize`/`Deserialize` calls — straightforward conversion.

## License

MIT.
