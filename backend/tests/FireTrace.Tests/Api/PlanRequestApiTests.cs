using System.Net;
using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Repositories;
using FireTrace.Core.Serialization;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace FireTrace.Tests.Api;

/// <summary>O operador pede um plano, um agente reclama-o, relata o progresso e fecha-o com os planos publicados.</summary>
public class PlanRequestApiTests : IClassFixture<ApiFactory>
{
    readonly ApiFactory _factory;
    readonly HttpClient _http;
    public PlanRequestApiTests(ApiFactory factory) => (_factory, _http) = (factory, factory.CreateClient());

    async Task<(HttpStatusCode Status, JsonNode? Body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, "/api/v1" + path);
        if (body is not null)
            request.Content = new StringContent(JsonSerializer.Serialize(body, ApiJson.Options), System.Text.Encoding.UTF8, method == HttpMethod.Patch ? "application/merge-patch+json" : "application/json");
        var response = await _http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text));
    }

    async Task<string> Baseline(SimulationKind kind = SimulationKind.Baseline, SimulationStatus status = SimulationStatus.Succeeded)
    {
        var id = $"sim-{Guid.NewGuid():N}"[..20];
        var store = _factory.Services.GetRequiredService<IDocumentStore<Simulation>>();
        await store.UpsertAsync(new Simulation
        {
            Id = id, Kind = kind, Status = status, LocationId = "guimaraes-concelho", CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
            ScenarioSnapshot = new Scenario { Name = "teste", LocationId = "guimaraes-concelho", Start = DateTimeOffset.UtcNow, DurationMinutes = 180, Ignitions = new() { new(new LatLon(41.43, -8.27)) } },
        });
        return id;
    }

    [Fact]
    public async Task A_request_goes_from_the_operator_to_an_agent_and_back_with_the_plans()
    {
        var sim = await Baseline();
        var (status, created) = await Send(HttpMethod.Post, $"/simulations/{sim}/plan-requests", new { note = "defender Sande", atMinute = 45 });
        Assert.Equal(HttpStatusCode.Accepted, status);
        var id = created!["id"]!.GetValue<string>();
        Assert.StartsWith("preq", id);
        Assert.Equal("queued", created["status"]!.GetValue<string>());
        Assert.Equal(45, created["atMinute"]!.GetValue<int>());

        // asking again while it is open gives the same request back
        var (again, same) = await Send(HttpMethod.Post, $"/simulations/{sim}/plan-requests");
        Assert.Equal(HttpStatusCode.OK, again);
        Assert.Equal(id, same!["id"]!.GetValue<string>());

        // the agent finds it among the queued ones and claims it; a second claim is refused
        var (_, queued) = await Send(HttpMethod.Get, "/plan-requests?status=queued");
        Assert.Contains(queued!["items"]!.AsArray(), r => r!["id"]!.GetValue<string>() == id);
        Assert.Equal(HttpStatusCode.Conflict, (await Send(HttpMethod.Patch, $"/plan-requests/{id}", new { status = "simulating" })).Status); // not claimed yet
        var (claimStatus, claimed) = await Send(HttpMethod.Post, $"/plan-requests/{id}/claim", new { agent = "agents@test" });
        Assert.Equal(HttpStatusCode.OK, claimStatus);
        Assert.Equal("planning", claimed!["status"]!.GetValue<string>());
        Assert.Equal("agents@test", claimed["claimedBy"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Conflict, (await Send(HttpMethod.Post, $"/plan-requests/{id}/claim", new { agent = "other" })).Status);

        // progress, then done (done needs the plans)
        var (_, progressing) = await Send(HttpMethod.Patch, $"/plan-requests/{id}", new { status = "simulating", progress = new { phase = "simulating", percent = 80, message = "what-if A e B" } });
        Assert.Equal("simulating", progressing!["status"]!.GetValue<string>());
        Assert.Equal(80, progressing["progress"]!["percent"]!.GetValue<double>());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Send(HttpMethod.Patch, $"/plan-requests/{id}", new { status = "done" })).Status);
        var (_, done) = await Send(HttpMethod.Patch, $"/plan-requests/{id}", new { status = "done", planIds = new[] { "pla-a", "pla-b" } });
        Assert.Equal("done", done!["status"]!.GetValue<string>());
        Assert.NotNull(done["completedAt"]);
        Assert.Equal(HttpStatusCode.Conflict, (await Send(HttpMethod.Patch, $"/plan-requests/{id}", new { status = "failed" })).Status); // final

        // the UI lists the requests of its baseline; a new one can be asked now
        var (_, mine) = await Send(HttpMethod.Get, $"/plan-requests?simulationId={sim}");
        Assert.Single(mine!["items"]!.AsArray());
        Assert.Equal(HttpStatusCode.Accepted, (await Send(HttpMethod.Post, $"/simulations/{sim}/plan-requests")).Status);
    }

    [Fact]
    public async Task Only_a_finished_baseline_can_be_planned()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await Send(HttpMethod.Post, "/simulations/sim-nope/plan-requests")).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await Send(HttpMethod.Post, $"/simulations/{await Baseline(status: SimulationStatus.Running)}/plan-requests")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Send(HttpMethod.Post, $"/simulations/{await Baseline(SimulationKind.WhatIf)}/plan-requests")).Status);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await Send(HttpMethod.Post, $"/simulations/{await Baseline()}/plan-requests", new { atMinute = 999 })).Status);
    }
}
