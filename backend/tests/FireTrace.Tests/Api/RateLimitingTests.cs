using System.Net;
using System.Text.Json.Nodes;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Api;

public class RateLimitingTests : IClassFixture<ApiFactory>
{
    const string EmptyPlan = "{\"locationId\":\"guimaraes\",\"title\":\"Plano Teste\",\"actions\":[]}";
    readonly ApiFactory _factory;
    readonly HttpClient _http;
    public RateLimitingTests(ApiFactory factory)
    {
        _factory = factory;
        _http = factory.CreateClient();
    }

    [Fact]
    public async Task Exceeding_rate_limit_returns_429_with_problem_and_retry_after()
    {
        // A direct caller cannot select its bucket through XFF. Use an isolated server so exhausting
        // the direct-client bucket does not affect other tests sharing this class's fixture.
        using var factory = new ApiFactory();
        using var http = factory.CreateClient();
        HttpResponseMessage? lastResponse = null;

        // Even rotating spoofed XFF values must still exhaust the same direct-client bucket.
        int limit = TestSettings.All.Limits.RateLimitPermitLimit;
        for (int i = 0; i < limit + 10; i++)
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
    public async Task The_internal_ip_window_is_wide_enough_for_the_agents_bursts()
    {
        // Internal agents have their own larger bucket; spoofed XFF must not select it.
        for (int i = 0; i < 400; i++)
        {
            var context = await _factory.Server.SendAsync(ctx =>
            {
                ctx.Connection.RemoteIpAddress = IPAddress.Parse("172.20.0.30");
                ctx.Request.Method = "GET";
                ctx.Request.Path = "/api/v1/health";
            });
            Assert.NotEqual((int)HttpStatusCode.TooManyRequests, context.Response.StatusCode);
        }
    }

    [Fact]
    public async Task Planning_endpoint_rate_limiting_policy_is_active()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/plans/validate");
        req.Content = new StringContent(EmptyPlan, System.Text.Encoding.UTF8, "application/json");
        var res = await _http.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Several_plan_validations_run_at_the_same_time_and_agree_with_a_serial_one()
    {
        async Task<string> Validate()
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/plans/validate");
            req.Content = new StringContent(EmptyPlan, System.Text.Encoding.UTF8, "application/json");
            var res = await _http.SendAsync(req);
            Assert.Equal(HttpStatusCode.OK, res.StatusCode); // antes: 1 de cada vez e 5 na fila, o resto levava 429
            var body = JsonNode.Parse(await res.Content.ReadAsStringAsync())!.AsObject();
            body.Remove("checkedAt");
            return body.ToJsonString();
        }

        var serial = await Validate();
        var parallel = await Task.WhenAll(Enumerable.Range(0, 24).Select(_ => Task.Run(Validate)));
        Assert.All(parallel, r => Assert.Equal(serial, r));
    }
}
