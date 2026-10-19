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

public class EndpointCoverageTests : IClassFixture<ApiFactory>
{
    readonly ApiFactory _factory;
    public EndpointCoverageTests(ApiFactory factory) => _factory = factory;

    static string Raw(RouteEndpoint e) => "/" + e.RoutePattern.RawText!.TrimStart('/');

    static string Normalize(string path) => System.Text.RegularExpressions.Regex.Replace(path.TrimEnd('/'), @"\{[^}/]+\}", "{}");

    [Fact]
    public void The_server_routes_exactly_the_operations_of_the_contract()
    {
        var spec = JsonNode.Parse(File.ReadAllText(ContractTests.SpecPath))!["paths"]!.AsObject();
        var declared = spec.SelectMany(p => p.Value!.AsObject().Where(m => m.Key is "get" or "post" or "put" or "patch" or "delete").Select(m => $"{m.Key.ToUpperInvariant()} {Normalize(p.Key)}")).ToHashSet();

        var routed = _factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => Raw(e).StartsWith("/api/v1") && !Raw(e).EndsWith("/openapi.json"))
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? Array.Empty<string>()).Select(m => $"{m} {Normalize(Raw(e)["/api/v1".Length..])}"))
            .ToHashSet();

        Assert.Empty(declared.Except(routed).Order());   // operações do contrato que o servidor não implementa
        Assert.Empty(routed.Except(declared).Order());   // rotas do servidor que o contrato não documenta
    }
}
