# Mnueron — .NET / C# SDK

A single-file client for the mnueron memory backend. Drop `MnueronClient.cs` into
any .NET 6+ project, no NuGet package required (uses built-in `System.Net.Http.Json`).

## Usage

```csharp
using Mnueron;

using var client = new MnueronClient("mn_xxxxxxxxxxxxxxxxxxxxxxx");

// Save a memory
var mem = await client.SaveAsync(
    content: "User prefers concise replies",
    @namespace: "my-app",
    tags: new[] { "preferences" }
);

// Semantic search
var results = await client.SearchAsync("how does the user like responses?", "my-app", k: 5);
foreach (var r in results)
    Console.WriteLine($"{r.Content} (score: {r.Score})");

// List recent
var recent = await client.ListAsync(@namespace: "my-app", limit: 20);

// Delete
await client.DeleteAsync(mem.Id);

// Bulk import
var result = await client.BulkSaveAsync(new[]
{
    new Dictionary<string, object?> { ["content"] = "fact 1", ["namespace"] = "my-app" },
    new Dictionary<string, object?> { ["content"] = "fact 2", ["namespace"] = "my-app" },
});
Console.WriteLine($"Saved: {result.Saved}, errors: {result.Errors}");
```

## Use with ASP.NET / dependency injection

```csharp
// Program.cs
builder.Services.AddHttpClient<MnueronClient>(c =>
{
    c.BaseAddress = new Uri("https://api.your-mnueron.com/");
});
builder.Services.AddSingleton(sp =>
    new MnueronClient(
        apiKey: builder.Configuration["Mnueron:ApiKey"]!,
        baseUrl: "https://api.your-mnueron.com",
        httpClient: sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(MnueronClient))
    )
);

// In a controller
public class ChatController : ControllerBase
{
    private readonly MnueronClient _mnueron;
    public ChatController(MnueronClient mnueron) => _mnueron = mnueron;

    [HttpPost("ask")]
    public async Task<IActionResult> Ask([FromBody] AskRequest req)
    {
        var context = await _mnueron.SearchAsync(req.Question, $"user-{User.Identity!.Name}", k: 5);
        // ... pass context to your LLM call
        return Ok();
    }
}
```

## Notes

- Wraps the exact same REST API as the Python SDK and the MCP server. Mix and match clients freely.
- For .NET Framework 4.8 or older, swap `System.Net.Http.Json` for manual `JsonSerializer.Serialize` / `Deserialize` calls — straightforward conversion.
- Cancellation tokens are honored on every method.

## License

MIT.
