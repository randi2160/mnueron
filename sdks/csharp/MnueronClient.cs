// MnueronClient.cs — .NET SDK for the mnueron memory backend.
//
// Wraps the hosted HTTP API at https://www.mnueron.com. Get a bearer token
// from /account-settings/tokens after signing up.
//
// Add to your project:
//   dotnet add package System.Text.Json
//
// Usage:
//   using Mnueron;
//   await using var client = new MnueronClient("mnu_xxx");
//   var mem = await client.SaveAsync("User prefers concise replies", "my-app");
//   foreach (var hit in await client.SearchAsync("how does the user like responses?",
//                                                 @namespace: "my-app", k: 5))
//       Console.WriteLine($"{hit.Content} ({hit.Score})");
//
// Endpoint coverage (v0.3.x):
//   - SaveAsync / SearchAsync / ListAsync / GetAsync / DeleteAsync / UpdateAsync
//   - BulkSearchAsync                                                (v0.2.3)
//   - Date-range + metadata containment filters on Search + List    (v0.2.1 / v0.2.4)
//   - NamespacesAsync, HealthAsync
//   - Webhook CRUD: ListWebhooks / CreateWebhook / GetWebhook /
//     UpdateWebhook / DeleteWebhook                                 (v0.3.1)
//   - VerifyWebhookSignature() — constant-time HMAC-SHA256 check.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
    [property: JsonPropertyName("metadata")] Dictionary<string, JsonElement>? Metadata = null,
    [property: JsonPropertyName("created_at")] long? CreatedAt = null,
    [property: JsonPropertyName("updated_at")] long? UpdatedAt = null
);

public record Namespace(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("count")] int Count,
    [property: JsonPropertyName("last_updated")] long LastUpdated
);

/// <summary>Single bulk-search result row: a query + its top-k hits.</summary>
public record BulkSearchResult(
    [property: JsonPropertyName("query")] string Query,
    [property: JsonPropertyName("hits")] List<Memory> Hits
);

internal record BulkSearchResponse(
    [property: JsonPropertyName("results")] List<BulkSearchResult> Results
);

internal record WebhookListResponse(
    [property: JsonPropertyName("endpoints")] List<WebhookEndpoint> Endpoints
);

/// <summary>
/// Webhook subscription. <c>Secret</c> is only set in the response of
/// <see cref="MnueronClient.CreateWebhookAsync"/> — record it then; it
/// won't be exposed by Get/List afterwards.
/// </summary>
public record WebhookEndpoint(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("events")] List<string> Events,
    [property: JsonPropertyName("description")] string? Description = null,
    [property: JsonPropertyName("enabled")] bool Enabled = true,
    [property: JsonPropertyName("secret")] string? Secret = null,
    [property: JsonPropertyName("consecutive_failures")] int ConsecutiveFailures = 0,
    [property: JsonPropertyName("last_success_at")] long? LastSuccessAt = null,
    [property: JsonPropertyName("last_failure_at")] long? LastFailureAt = null,
    [property: JsonPropertyName("created_at")] long? CreatedAt = null,
    [property: JsonPropertyName("updated_at")] long? UpdatedAt = null
);

public class MnueronException : Exception
{
    public int StatusCode { get; }
    public MnueronException(int statusCode, string message) : base($"mnueron API {statusCode}: {message}")
    {
        StatusCode = statusCode;
    }
}

public sealed class MnueronClient : IDisposable, IAsyncDisposable
{
    public const string DefaultBaseUrl = "https://www.mnueron.com";

    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;

    public MnueronClient(
        string? apiKey = null,
        string? baseUrl = null,
        HttpClient? httpClient = null)
    {
        apiKey ??= Environment.GetEnvironmentVariable("MNUERON_API_KEY")
                ?? Environment.GetEnvironmentVariable("MNUERON_API_TOKEN");
        if (string.IsNullOrEmpty(apiKey))
            throw new ArgumentException("apiKey required (or set MNUERON_API_KEY)", nameof(apiKey));

        baseUrl ??= Environment.GetEnvironmentVariable("MNUERON_API_URL") ?? DefaultBaseUrl;

        _http = httpClient ?? new HttpClient();
        _ownsHttp = httpClient is null;
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("mnueron-dotnet/0.3");
    }

    // ─── memories ─────────────────────────────────────────────────────────

    public async Task<Memory> SaveAsync(
        string content,
        string @namespace = "default",
        IEnumerable<string>? tags = null,
        string source = "sdk",
        string? sourceRef = null,
        IDictionary<string, object?>? metadata = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["content"] = content,
            ["namespace"] = @namespace,
            ["tags"] = tags is null ? Array.Empty<string>() : tags.ToArray(),
            ["source"] = source,
        };
        if (sourceRef is not null) body["source_ref"] = sourceRef;
        if (metadata is not null) body["metadata"] = metadata;

        var resp = await _http.PostAsJsonAsync("api/memories", body, _jsonOpts, ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        return (await resp.Content.ReadFromJsonAsync<Memory>(_jsonOpts, ct).ConfigureAwait(false))!;
    }

    /// <summary>
    /// BM25 search over /api/memories with optional date-range + metadata
    /// containment filters.
    /// </summary>
    public async Task<IReadOnlyList<Memory>> SearchAsync(
        string query,
        string? @namespace = null,
        int k = 10,
        long? createdAfter = null,
        long? createdBefore = null,
        long? updatedAfter = null,
        long? updatedBefore = null,
        IDictionary<string, object?>? metadataFilter = null,
        CancellationToken ct = default)
    {
        var qs = BuildListQuerystring(
            q: query, @namespace: @namespace, limit: k, offset: 0,
            createdAfter, createdBefore, updatedAfter, updatedBefore,
            metadataFilter);
        var resp = await _http.GetAsync($"api/memories?{qs}", ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        return (await resp.Content.ReadFromJsonAsync<List<Memory>>(_jsonOpts, ct).ConfigureAwait(false)) ?? new();
    }

    /// <summary>v0.2.3 — up to 25 queries in one HTTP round-trip.</summary>
    public async Task<IReadOnlyList<BulkSearchResult>> BulkSearchAsync(
        IEnumerable<string> queries,
        string? @namespace = null,
        int k = 5,
        long? createdAfter = null,
        long? createdBefore = null,
        IDictionary<string, object?>? metadataFilter = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["queries"] = queries.ToArray(),
            ["k"] = k,
        };
        if (@namespace is not null)     body["namespace"] = @namespace;
        if (createdAfter is not null)   body["created_after"] = createdAfter;
        if (createdBefore is not null)  body["created_before"] = createdBefore;
        if (metadataFilter is not null) body["metadata_filter"] = metadataFilter;

        var resp = await _http.PostAsJsonAsync("api/memories/search/bulk", body, _jsonOpts, ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        var payload = await resp.Content.ReadFromJsonAsync<BulkSearchResponse>(_jsonOpts, ct).ConfigureAwait(false);
        return payload?.Results ?? new();
    }

    public async Task<IReadOnlyList<Memory>> ListAsync(
        string? @namespace = null,
        int limit = 50,
        int offset = 0,
        long? createdAfter = null,
        long? createdBefore = null,
        long? updatedAfter = null,
        long? updatedBefore = null,
        IDictionary<string, object?>? metadataFilter = null,
        CancellationToken ct = default)
    {
        var qs = BuildListQuerystring(
            q: null, @namespace: @namespace, limit: limit, offset: offset,
            createdAfter, createdBefore, updatedAfter, updatedBefore,
            metadataFilter);
        var resp = await _http.GetAsync($"api/memories?{qs}", ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        return (await resp.Content.ReadFromJsonAsync<List<Memory>>(_jsonOpts, ct).ConfigureAwait(false)) ?? new();
    }

    public async Task<Memory?> GetAsync(string memoryId, CancellationToken ct = default)
    {
        var resp = await _http.GetAsync($"api/memories/{Uri.EscapeDataString(memoryId)}", ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        await EnsureSuccess(resp).ConfigureAwait(false);
        return await resp.Content.ReadFromJsonAsync<Memory>(_jsonOpts, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// v0.2.2 — partial update. Metadata is MERGED into the existing keys;
    /// pass a value of <c>null</c> in <paramref name="metadata"/> to remove
    /// a key.
    /// </summary>
    public async Task<Memory> UpdateAsync(
        string memoryId,
        string? content = null,
        IEnumerable<string>? tags = null,
        string? @namespace = null,
        IDictionary<string, object?>? metadata = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>();
        if (content is not null)    body["content"] = content;
        if (tags is not null)       body["tags"] = tags.ToArray();
        if (@namespace is not null) body["namespace"] = @namespace;
        if (metadata is not null)   body["metadata"] = metadata;
        if (body.Count == 0)
            throw new ArgumentException("UpdateAsync requires at least one field");

        var req = new HttpRequestMessage(HttpMethod.Patch,
            $"api/memories/{Uri.EscapeDataString(memoryId)}")
        {
            Content = JsonContent.Create(body, options: _jsonOpts),
        };
        var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        return (await resp.Content.ReadFromJsonAsync<Memory>(_jsonOpts, ct).ConfigureAwait(false))!;
    }

    public async Task DeleteAsync(string memoryId, CancellationToken ct = default)
    {
        var resp = await _http.DeleteAsync($"api/memories/{Uri.EscapeDataString(memoryId)}", ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
    }

    // ─── namespaces / health ─────────────────────────────────────────────

    public async Task<IReadOnlyList<Namespace>> NamespacesAsync(CancellationToken ct = default)
    {
        var resp = await _http.GetAsync("api/namespaces", ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        return (await resp.Content.ReadFromJsonAsync<List<Namespace>>(_jsonOpts, ct).ConfigureAwait(false)) ?? new();
    }

    public async Task<bool> HealthAsync(CancellationToken ct = default)
    {
        var resp = await _http.GetAsync("api/health", ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode) return false;
        try
        {
            var doc = await resp.Content.ReadFromJsonAsync<JsonElement>(_jsonOpts, ct).ConfigureAwait(false);
            return doc.TryGetProperty("ok", out var ok) && ok.GetBoolean();
        }
        catch { return false; }
    }

    // ─── webhooks (v0.3.1) ───────────────────────────────────────────────

    public async Task<IReadOnlyList<WebhookEndpoint>> ListWebhooksAsync(CancellationToken ct = default)
    {
        var resp = await _http.GetAsync("api/webhooks", ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        var payload = await resp.Content.ReadFromJsonAsync<WebhookListResponse>(_jsonOpts, ct).ConfigureAwait(false);
        return payload?.Endpoints ?? new();
    }

    /// <summary>
    /// Register a webhook. The returned <see cref="WebhookEndpoint.Secret"/>
    /// is exposed exactly once — record it before the call returns.
    /// </summary>
    public async Task<WebhookEndpoint> CreateWebhookAsync(
        string url,
        IEnumerable<string>? events = null,
        string? description = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?> { ["url"] = url };
        if (events is not null)      body["events"] = events.ToArray();
        if (description is not null) body["description"] = description;

        var resp = await _http.PostAsJsonAsync("api/webhooks", body, _jsonOpts, ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
        return (await resp.Content.ReadFromJsonAsync<WebhookEndpoint>(_jsonOpts, ct).ConfigureAwait(false))!;
    }

    public async Task<WebhookEndpoint?> GetWebhookAsync(string endpointId, CancellationToken ct = default)
    {
        var resp = await _http.GetAsync($"api/webhooks/{Uri.EscapeDataString(endpointId)}", ct).ConfigureAwait(false);
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        await EnsureSuccess(resp).ConfigureAwait(false);
        return await resp.Content.ReadFromJsonAsync<WebhookEndpoint>(_jsonOpts, ct).ConfigureAwait(false);
    }

    public async Task UpdateWebhookAsync(
        string endpointId,
        string? url = null,
        IEnumerable<string>? events = null,
        bool? enabled = null,
        string? description = null,
        CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>();
        if (url is not null)         body["url"] = url;
        if (events is not null)      body["events"] = events.ToArray();
        if (enabled is not null)     body["enabled"] = enabled;
        if (description is not null) body["description"] = description;
        if (body.Count == 0)
            throw new ArgumentException("UpdateWebhookAsync requires at least one field");

        var req = new HttpRequestMessage(HttpMethod.Put,
            $"api/webhooks/{Uri.EscapeDataString(endpointId)}")
        {
            Content = JsonContent.Create(body, options: _jsonOpts),
        };
        var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
    }

    public async Task DeleteWebhookAsync(string endpointId, CancellationToken ct = default)
    {
        var resp = await _http.DeleteAsync($"api/webhooks/{Uri.EscapeDataString(endpointId)}", ct).ConfigureAwait(false);
        await EnsureSuccess(resp).ConfigureAwait(false);
    }

    /// <summary>
    /// Constant-time verification of an incoming mnueron webhook delivery.
    /// <para>
    /// mnueron signs each delivery with HMAC-SHA256 over the raw request
    /// body and sends the hex digest in the <c>X-Mnueron-Signature</c>
    /// header prefixed with <c>sha256=</c>.
    /// </para>
    /// </summary>
    public static bool VerifyWebhookSignature(string secret, byte[] body, string signatureHeader)
    {
        if (string.IsNullOrEmpty(signatureHeader)) return false;
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var hash = hmac.ComputeHash(body);
        var expected = "sha256=" + Convert.ToHexString(hash).ToLowerInvariant();
        var got = signatureHeader.Trim();
        var a = Encoding.UTF8.GetBytes(expected);
        var b = Encoding.UTF8.GetBytes(got);
        if (a.Length != b.Length) return false;
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    // ─── internals ───────────────────────────────────────────────────────

    /// <summary>
    /// Build the querystring for GET /api/memories. Returns "limit=…&amp;offset=…"
    /// plus whatever filters were supplied. Doesn't include the leading '?'.
    /// </summary>
    private static string BuildListQuerystring(
        string? q,
        string? @namespace,
        int limit,
        int offset,
        long? createdAfter,
        long? createdBefore,
        long? updatedAfter,
        long? updatedBefore,
        IDictionary<string, object?>? metadataFilter)
    {
        var parts = new List<string>
        {
            $"limit={limit}",
            $"offset={offset}",
        };
        if (!string.IsNullOrEmpty(q))
            parts.Add($"q={Uri.EscapeDataString(q)}");
        if (!string.IsNullOrEmpty(@namespace))
            parts.Add($"namespace={Uri.EscapeDataString(@namespace)}");
        if (createdAfter is not null)  parts.Add($"created_after={createdAfter}");
        if (createdBefore is not null) parts.Add($"created_before={createdBefore}");
        if (updatedAfter is not null)  parts.Add($"updated_after={updatedAfter}");
        if (updatedBefore is not null) parts.Add($"updated_before={updatedBefore}");
        if (metadataFilter is { Count: > 0 })
        {
            // Server expects a JSON object passed straight to Postgres `@>`.
            var json = JsonSerializer.Serialize(metadataFilter, _jsonOpts);
            parts.Add($"metadata_filter={Uri.EscapeDataString(json)}");
        }
        return string.Join("&", parts);
    }

    private static async Task EnsureSuccess(HttpResponseMessage resp)
    {
        if (resp.IsSuccessStatusCode) return;
        var raw = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        // Surface the JSON `error` field when present.
        string msg = raw;
        try
        {
            var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.TryGetProperty("error", out var err)
                && err.ValueKind == JsonValueKind.String)
                msg = err.GetString() ?? raw;
        }
        catch { /* not JSON — fall through */ }
        throw new MnueronException((int)resp.StatusCode, msg);
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }
}
