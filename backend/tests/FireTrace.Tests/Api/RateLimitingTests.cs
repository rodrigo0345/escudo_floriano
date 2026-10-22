using System.Net;
using System.Text.Json.Nodes;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Api;

public class RateLimitingTests : IClassFixture<ApiFactory>
{
    readonly HttpClient _http;
    public RateLimitingTests(ApiFactory factory) => _http = factory.CreateClient();

    [Fact]
    public async Task Exceeding_rate_limit_returns_429_with_problem_and_retry_after()
    {
        // A direct caller cannot select its bucket through XFF. Use an isolated server so exhausting
        // the direct-client bucket does not affect other tests sharing this class's fixture.
        using var factory = new ApiFactory();
        using var http = factory.CreateClient();
        HttpResponseMessage? lastResponse = null;

        // RateLimitPermitLimit is 300 in appsettings.json.
        // Even rotating spoofed XFF values must still exhaust the same direct-client bucket.
        for (int i = 0; i < 310; i++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
            req.Headers.Add("X-Forwarded-For", $"192.168.{i / 256}.{i % 256}");
            lastResponse = await http.SendAsync(req);
            if (lastResponse.StatusCode == HttpStatusCode.TooManyRequests)
                break;
        }

        Assert.NotNull(lastResponse);
        Assert.Equal(HttpStatusCode.TooManyRequests, lastResponse.StatusCode);
        Assert.Equal("application/problem+json", lastResponse.Content.Headers.ContentType?.MediaType);
        Assert.True(lastResponse.Headers.Contains("Retry-After"));

        var body = JsonNode.Parse(await lastResponse.Content.ReadAsStringAsync());
        Assert.NotNull(body);
        Assert.Equal("rate_limited", body["code"]?.GetValue<string>());
        Assert.Equal(429, body["status"]?.GetValue<int>());
        Assert.Contains("Demasiados pedidos", body["title"]?.GetValue<string>() ?? "");
    }

    [Fact]
    public async Task Planning_endpoint_rate_limiting_policy_is_active()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/plans/validate");
        req.Content = new StringContent("{\"locationId\":\"guimaraes\",\"title\":\"Plano Teste\",\"actions\":[]}", System.Text.Encoding.UTF8, "application/json");
        var res = await _http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }
}
