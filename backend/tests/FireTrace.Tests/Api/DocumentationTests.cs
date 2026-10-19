using System.Net.Http.Json;
using System.Net;
using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Tests.Support;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace FireTrace.Tests.Api;

public class DocumentationTests
{
    readonly HttpClient _http = ApiFactory.WithoutDatabase().CreateClient(); // pior caso: a base de dados ainda não está pronta

    [Theory]
    [InlineData("/swagger/index.html")]
    [InlineData("/api/v1/openapi.json")]
    [InlineData("/api/v1/health")]
    [InlineData("/api/v1/capabilities")]
    [InlineData("/api/v1/rules")]
    public async Task Docs_health_and_rules_answer_even_when_the_database_is_not_ready(string path) =>
        Assert.Equal(HttpStatusCode.OK, (await _http.GetAsync(path)).StatusCode);

    [Fact]
    public async Task Everything_else_answers_503_problem_until_the_database_is_ready()
    {
        var response = await _http.GetAsync("/api/v1/organizations");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("engine_unavailable", (await response.Content.ReadFromJsonAsync<JsonObject>())!["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_swagger_page_points_at_the_spec_in_the_repository()
    {
        Assert.Contains("api/v1/openapi.json", await _http.GetStringAsync("/swagger/index.js"));
        var served = JsonNode.Parse(await _http.GetStringAsync("/api/v1/openapi.json"))!;
        Assert.Equal("3.1.0", served["openapi"]!.GetValue<string>());
    }
}
