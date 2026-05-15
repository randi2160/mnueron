// MnueronClient.cs — .NET SDK for the mnueron memory backend.
//
// Add to your project:
//   dotnet add package System.Text.Json
//
// Usage:
//   var client = new MnueronClient("mn_xxx");
//   var mem = await client.SaveAsync("User prefers concise replies", "my-app");
//   var results = await client.SearchAsync("how does the user like responses?", "my-app");
//   foreach (var r in results) Console.WriteLine($"{r.Content} ({r.Score})");

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Mnueron;

public record Memory(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("namespace")] string Namespace,
    [property: JsonPropertyName("content")] string Content,
    [property: JsonPropertyName("tags")] List<string> Tags,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("score")] double? Score = null,
    [property: JsonPropertyName("source_ref")] string? SourceRef = null,
    [property: JsonPropertyName("metadata")] Dictionary<string, object>? Metadata = null,
    [property: JsonPropertyName("created_at")] long? CreatedAt = null,
    [property: JsonPropertyName("updated_at")] long? UpdatedAt = null
);

public record Namespace(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("count")] int Count,
    [property: JsonPropertyName("last_updated")] long LastUpdated
);

public record BulkResult(
    [property: JsonPropertyName("saved")] int Saved,
    [property: JsonPropertyName("errors")] int Errors
);

public class MnueronException : Exception
{
    public int StatusCode { get; }
    public MnueronException(int statusCode, string message) : base($"mnueron API {statusCode}: {message}")
    {
        StatusCode = statusCode;
    }
}

public sealed class MnueronClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;

    public MnueronClient(
        string apiKey,
        string baseUrl = "https://api.mnueron.dev",
        HttpClient? httpClient = null)
    {
        if (string.IsNullOrEmpty(apiKey))
            throw new ArgumentException("apiKey is required", nameof(apiKey));

        _http = httpClient ?? new HttpClient();
        _ownsHttp = httpClient is null;
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("mnueron-dotnet/0.1");
    }

    public async Task<Memory> SaveAsync(
        string content,
        string @namespace = "default",
        IEnumerable<string>? tags = null,
        string source = "sdk",
        string? sourceRef = null,
        Dictionary<string, object>? metadata = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["content"] = content,
            ["namespace"] = @namespace,
            ["tags"] = tags is null ? Array.Empty<string>() : (object)tags,
            ["source"] = source,
        };
        if (sourceRef is not null) body["source_ref"] = sourceRef;
        if (metadata is not null) body["metadata"] = metadata;

        var resp = await _http.PostAsJsonAsync("v1/memories", body, ct).ConfigureAwait(false);
        await EnsureSuccess(resp);
        return (await resp.Content.ReadFromJsonAsync<Memory>(cancellationToken: ct))!;
    }

    public async Task<IReadOnlyList<Memory>> SearchAsync(
        string query,
        string? @namespace = null,
        int k = 10,
        IEnumerable<string>? tags = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?> { ["query"] = query, ["k"] = k };
        if (@namespace is not null) body["namespace"] = @namespace;
        if (tags is not null) body["tags"] = tags;

        var resp = await _http.PostAsJsonAsync("v1/memories/search", body, ct).ConfigureAwait(false);
        await EnsureSuccess(resp);
        return (await resp.Content.ReadFromJsonAsync<List<Memory>>(cancellationToken: ct)) ?? new();
    }

    public async Task<IReadOnlyList<Memory>> ListAsync(
        string? @namespace = null,
        int limit = 50,
        long? before = null,
        CancellationToken ct = default)
    {
        var qs = new List<string> { $"limit={limit}" };
        if (@namespace is not null) qs.Add($"namespace={Uri.EscapeDataString(@namespace)}");
        if (before is not null) qs.Add($"before={before}");

        var resp = await _http.GetAsync($"v1/memories?{string.Join("&", qs)}", ct).ConfigureAwait(false);
        await EnsureSuccess(resp);
        return (await resp.Content.ReadFromJsonAsync<List<Memory>>(cancellationToken: ct)) ?? new();
    }

    public async Task<Memory?> GetAsync(string memoryId, CancellationToken ct = default)
    {
        var resp = await _http.GetAsync($"v1/memories/{Uri.EscapeDataString(memoryId)}", ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        await EnsureSuccess(resp);
        return await resp.Content.ReadFromJsonAsync<Memory>(cancellationToken: ct);
    }

    public async Task DeleteAsync(string memoryId, CancellationToken ct = default)
    {
        var resp = await _http.DeleteAsync($"v1/memories/{Uri.EscapeDataString(memoryId)}", ct).ConfigureAwait(false);
        await EnsureSuccess(resp);
    }

    public async Task<IReadOnlyList<Namespace>> NamespacesAsync(CancellationToken ct = default)
    {
        var resp = await _http.GetAsync("v1/namespaces", ct).ConfigureAwait(false);
        await EnsureSuccess(resp);
        return (await resp.Content.ReadFromJsonAsync<List<Namespace>>(cancellationToken: ct)) ?? new();
    }

    public async Task<BulkResult> BulkSaveAsync(
        IEnumerable<Dictionary<string, object?>> items,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object> { ["items"] = items };
        var resp = await _http.PostAsJsonAsync("v1/memories/bulk", body, ct).ConfigureAwait(false);
        await EnsureSuccess(resp);
        return (await resp.Content.ReadFromJsonAsync<BulkResult>(cancellationToken: ct))!;
    }

    private static async Task EnsureSuccess(HttpResponseMessage resp)
    {
        if (resp.IsSuccessStatusCode) return;
        var text = await resp.Content.ReadAsStringAsync();
        throw new MnueronException((int)resp.StatusCode, text);
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}
