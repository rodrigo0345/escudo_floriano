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
        const string clientIp = "192.168.1.100";
        // a janela por IP vem do appsettings.json: um pedido a mais do que isso tem de levar 429
        int limit = TestSettings.All.Limits.RateLimitPermitLimit;
        HttpResponseMessage? lastResponse = null;

        for (int i = 0; i < limit + 10; i++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
            req.Headers.Add("X-Forwarded-For", clientIp);
            lastResponse = await _http.SendAsync(req);
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
    public async Task The_per_ip_window_is_wide_enough_for_the_agents_bursts()
    {
        // 300 pedidos por minuto deixavam os agentes a levar 429 a meio de um plano
        for (int i = 0; i < 400; i++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
            req.Headers.Add("X-Forwarded-For", "192.168.1.101");
            var res = await _http.SendAsync(req);
            Assert.NotEqual(HttpStatusCode.TooManyRequests, res.StatusCode);
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
