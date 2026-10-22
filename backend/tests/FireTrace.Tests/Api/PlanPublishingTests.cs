using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Api;

/// <summary>Publicar um plano valida-o uma só vez e continua a recusar o que tem erros: a validação é cara e não se repete, mas nada do que ela apanhava passa.</summary>
public class PlanPublishingTests : IClassFixture<ApiFactory>
{
    readonly HttpClient _http;
    public PlanPublishingTests(ApiFactory factory) => _http = factory.CreateClient();

    async Task<(HttpStatusCode Status, JsonNode? Body)> Post(string path, string json)
    {
        var response = await _http.PostAsync("/api/v1" + path, new StringContent(json, Encoding.UTF8, "application/json"));
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text));
    }

    static string PlanWith(string organizationId, string actionId = "act-1") =>
        $$$"""
        {"locationId":"guimaraes","title":"Plano teste","variant":"A","actions":[
          {"type":"fire_attack","id":"{{{actionId}}}","title":"Ataque","organizationId":"{{{organizationId}}}","priority":"high","tactic":"direct_attack","anchorPoint":{"lat":41.43,"lon":-8.27}}]}
        """;

    async Task<string> FirstOrganizationId()
    {
        var response = await _http.GetAsync("/api/v1/organizations?limit=1");
        var items = JsonNode.Parse(await response.Content.ReadAsStringAsync())?["items"]?.AsArray();
        if (items is { Count: > 0 }) return items[0]!["id"]!.GetValue<string>();
        var (_, created) = await Post("/organizations", """{"name":"Corpo de Teste","type":"fire_brigade","active":true}""");
        return created!["id"]!.GetValue<string>();
    }

    [Fact]
    public async Task A_plan_with_errors_is_refused_with_the_issues_and_not_stored()
    {
        var (status, body) = await Post("/plans", PlanWith("org-que-nao-existe"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        Assert.Equal("validation_failed", body?["code"]?.GetValue<string>());
        Assert.Contains(body!["errors"]!.AsArray(), e => e?["code"]?.GetValue<string>() == "unknown_organization");

        var list = await _http.GetStringAsync("/api/v1/plans?limit=200");
        Assert.DoesNotContain("act-1", list); // nada ficou guardado
    }

    [Fact]
    public async Task A_valid_plan_is_created_with_its_validation_attached()
    {
        var org = await FirstOrganizationId();
        var (status, plan) = await Post("/plans", PlanWith(org, "act-ok"));
        Assert.Equal(HttpStatusCode.Created, status);
        Assert.Equal("proposed", plan?["status"]?.GetValue<string>());
        Assert.True(plan?["validation"]?["valid"]?.GetValue<bool>());
        Assert.NotNull(plan?["validation"]?["checkedAt"]);
    }

    [Fact]
    public async Task The_issues_a_plan_is_refused_for_are_the_ones_validate_reports()
    {
        var (_, validation) = await Post("/plans/validate", PlanWith("org-que-nao-existe", "act-2"));
        var (status, refused) = await Post("/plans", PlanWith("org-que-nao-existe", "act-2"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        var expected = validation!["issues"]!.AsArray().Select(i => i!["code"]!.GetValue<string>() + i["pointer"]).Order().ToList();
        var actual = refused!["errors"]!.AsArray().Select(i => i!["code"]!.GetValue<string>() + i["pointer"]).Order().ToList();
        Assert.Equal(expected, actual);
    }
}
