using System.Net.Http.Json;
using System.Net;
using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Serialization;
using FireTrace.ExternalData.Store;
using FireTrace.Tests.Support;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace FireTrace.Tests.Api;

public class ResourceApiTests : IClassFixture<ApiFactory>
{
    readonly HttpClient _http;
    public ResourceApiTests(ApiFactory factory) => _http = factory.CreateClient();

    async Task<JsonObject> Send(HttpMethod method, string path, object? body = null, HttpStatusCode? expect = null)
    {
        using var request = new HttpRequestMessage(method, "/api/v1" + path);
        if (body is not null) request.Content = new StringContent(body is string s ? s : JsonSerializer.Serialize(body, ApiJson.Options), System.Text.Encoding.UTF8, method == HttpMethod.Patch ? "application/merge-patch+json" : "application/json");
        var response = await _http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (expect is { } code) Assert.True(code == response.StatusCode, $"{method} {path}: esperava {code}, veio {(int)response.StatusCode} {text}");
        return text.Length == 0 ? new JsonObject() : JsonNode.Parse(text)!.AsObject();
    }

    static string Str(JsonObject o, string key) => o[key]!.GetValue<string>();

    async Task<string> Org(string name = "Bombeiros", string type = "fire_brigade") => Str(await Send(HttpMethod.Post, "/organizations", new { name, type }, HttpStatusCode.Created), "id");

    async Task<string> Vehicle(string org, string callsign, string[]? capabilities = null) => Str(await Send(HttpMethod.Post, "/vehicles",
        new { organizationId = org, callsign, type = "forest_firefighting_vehicle", crewCapacity = 5, minimumCrew = 3, waterCapacityL = 3000, offRoad = true, capabilities = capabilities ?? new[] { "wildfire_attack" } },
        HttpStatusCode.Created), "id");

    [Fact]
    public async Task Resources_can_be_created_read_patched_listed_and_deleted()
    {
        var org = await Org();
        var station = Str(await Send(HttpMethod.Post, "/stations", new { organizationId = org, name = "Quartel", kind = "fire_station", locationId = "guimaraes", position = new { lat = 41.4425, lon = -8.2918 } }, HttpStatusCode.Created), "id");
        var vehicle = await Vehicle(org, "VFCI-01");

        var patched = await Send(HttpMethod.Patch, $"/vehicles/{vehicle}", new { callsign = "VFCI-02", stationId = station }, HttpStatusCode.OK);
        Assert.Equal("VFCI-02", Str(patched, "callsign"));
        Assert.Equal(1, (await Send(HttpMethod.Get, $"/vehicles?stationId={station}&type=forest_firefighting_vehicle", expect: HttpStatusCode.OK))["total"]!.GetValue<int>());
        Assert.Equal(0, (await Send(HttpMethod.Get, "/vehicles?type=ambulance", expect: HttpStatusCode.OK))["total"]!.GetValue<int>());
        Assert.True((await Send(HttpMethod.Get, "/vehicles", expect: HttpStatusCode.OK)).ContainsKey("nextCursor")); // o contrato exige o campo (null na última página)

        await Send(HttpMethod.Delete, $"/organizations/{org}", expect: HttpStatusCode.Conflict); // ainda tem postos e viaturas
        await Send(HttpMethod.Delete, $"/vehicles/{vehicle}", expect: HttpStatusCode.NoContent);
        await Send(HttpMethod.Delete, $"/stations/{station}", expect: HttpStatusCode.NoContent);
        await Send(HttpMethod.Delete, $"/organizations/{org}", expect: HttpStatusCode.NoContent);
        await Send(HttpMethod.Get, $"/organizations/{org}", expect: HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Errors_are_problem_json_with_a_code_and_pointers()
    {
        var problem = await Send(HttpMethod.Post, "/vehicles", new { organizationId = "org-nope", callsign = "X", type = "ambulance", crewCapacity = 2, minimumCrew = 5 }, HttpStatusCode.UnprocessableEntity);
        Assert.Equal("validation_failed", Str(problem, "code"));
        var codes = problem["errors"]!.AsArray().Select(e => e!["code"]!.GetValue<string>()).ToList();
        Assert.Contains("unknown_organization", codes);
        Assert.Contains("invalid_crew", codes);
        Assert.Equal("/organizationId", problem["errors"]!.AsArray().First(e => e!["code"]!.GetValue<string>() == "unknown_organization")!["pointer"]!.GetValue<string>());

        Assert.Equal("bad_request", Str(await Send(HttpMethod.Post, "/organizations", "{not json", HttpStatusCode.BadRequest), "code"));
        Assert.Equal("not_found", Str(await Send(HttpMethod.Get, "/vehicles/veh-nope", expect: HttpStatusCode.NotFound), "code"));
        Assert.Equal("validation_failed", Str(await Send(HttpMethod.Get, "/simulations/sim-x/units", expect: HttpStatusCode.UnprocessableEntity), "code"));
        Assert.Equal("not_found", Str(await Send(HttpMethod.Get, "/simulations/sim-x/units?tMin=0", expect: HttpStatusCode.NotFound), "code"));
    }

    [Fact]
    public async Task Vehicle_state_is_updated_separately_and_checked_against_the_crew_capacity()
    {
        var vehicle = await Vehicle(await Org(), "VFCI-01");
        var state = await Send(HttpMethod.Patch, $"/vehicles/{vehicle}/state", new { status = "on_scene", crewOnboard = 4, water = new { levelL = 2400 } }, HttpStatusCode.OK);
        Assert.Equal("on_scene", Str(state, "status"));
        Assert.Equal(2400, (await Send(HttpMethod.Get, $"/vehicles/{vehicle}/state", expect: HttpStatusCode.OK))["water"]!["levelL"]!.GetValue<int>());
        await Send(HttpMethod.Patch, $"/vehicles/{vehicle}/state", new { crewOnboard = 9 }, HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Dispatches_reserve_vehicles_and_people_and_release_them()
    {
        var org = await Org();
        var vehicle = await Vehicle(org, "VFCI-01"); var wrong = await Vehicle(org, "VT-01", new[] { "traffic_control" });
        var pool = Str(await Send(HttpMethod.Post, "/personnel-pools", new { organizationId = org, role = "forest_firefighter", total = 12, available = 12 }, HttpStatusCode.Created), "id");
        var target = new { label = "Frente", position = new { lat = 41.46, lon = -8.27 } };

        var check = await Send(HttpMethod.Post, "/dispatches/validate", new { dispatches = new object[] {
            new { resourceType = "vehicle", resourceId = vehicle, personnel = 9, responsibility = "firefighting", target },
            new { resourceType = "vehicle", resourceId = wrong, personnel = 4, responsibility = "firefighting", target },
            new { resourceType = "personnel_pool", resourceId = pool, personnel = 20, responsibility = "firefighting", target } } }, HttpStatusCode.OK);
        Assert.False(check["valid"]!.GetValue<bool>());
        var codes = check["issues"]!.AsArray().Select(i => i!["code"]!.GetValue<string>()).ToList();
        Assert.Contains("crew_range", codes); Assert.Contains("responsibility_not_supported", codes); Assert.Contains("not_enough_personnel", codes);

        var created = await Send(HttpMethod.Post, "/dispatches", new { reason = "teste", dispatches = new object[] {
            new { resourceType = "vehicle", resourceId = vehicle, personnel = 4, responsibility = "firefighting", target },
            new { resourceType = "personnel_pool", resourceId = pool, personnel = 5, responsibility = "firefighting", target } } }, HttpStatusCode.Created);
        var items = created["items"]!.AsArray();
        var vehicleDispatch = Str(items[0]!.AsObject(), "id"); var poolDispatch = Str(items[1]!.AsObject(), "id");

        var state = await Send(HttpMethod.Get, $"/vehicles/{vehicle}/state", expect: HttpStatusCode.OK);
        Assert.Equal("dispatched", Str(state, "status")); Assert.Equal("firefighting", Str(state, "responsibility")); Assert.Equal(vehicleDispatch, Str(state, "currentDispatchId"));
        var poolNow = await Send(HttpMethod.Get, $"/personnel-pools/{pool}", expect: HttpStatusCode.OK);
        Assert.Equal(7, poolNow["available"]!.GetValue<int>()); Assert.Equal(5, poolNow["deployed"]!.GetValue<int>());

        await Send(HttpMethod.Post, "/dispatches", new { dispatches = new object[] { new { resourceType = "vehicle", resourceId = vehicle, personnel = 4, responsibility = "firefighting", target } } }, HttpStatusCode.UnprocessableEntity); // já ocupada
        var deployment = await Send(HttpMethod.Get, "/locations/guimaraes/deployment", expect: HttpStatusCode.OK);
        Assert.Equal("firefighting", deployment["byResponsibility"]![0]!["responsibility"]!.GetValue<string>());

        Assert.Equal("working", Str(await Send(HttpMethod.Patch, $"/dispatches/{vehicleDispatch}", new { status = "working" }, HttpStatusCode.OK), "status"));
        Assert.Equal("returning", Str(await Send(HttpMethod.Post, $"/dispatches/{vehicleDispatch}/recall", new { reason = "fim" }, HttpStatusCode.OK), "status"));
        await Send(HttpMethod.Post, $"/dispatches/{poolDispatch}/recall", expect: HttpStatusCode.OK);
        Assert.Equal(12, (await Send(HttpMethod.Get, $"/personnel-pools/{pool}", expect: HttpStatusCode.OK))["available"]!.GetValue<int>());
        await Send(HttpMethod.Patch, $"/dispatches/{vehicleDispatch}", new { status = "completed" }, HttpStatusCode.OK);
        Assert.Equal("available", Str(await Send(HttpMethod.Get, $"/vehicles/{vehicle}/state", expect: HttpStatusCode.OK), "status"));
        await Send(HttpMethod.Post, $"/dispatches/{vehicleDispatch}/recall", expect: HttpStatusCode.Conflict); // já terminou
    }

    [Fact]
    public async Task Plans_go_from_proposed_to_selected_to_active_and_closing_frees_the_vehicles()
    {
        var org = await Org(); var vehicle = await Vehicle(org, "VFCI-01");
        object Plan(string variant) => new
        {
            locationId = "guimaraes", title = $"Plano {variant}", variant, strategy = "Contenção",
            actions = new object[]
            {
                new { type = "fire_attack", id = "a-01", title = "Atacar", organizationId = org, tactic = "direct", anchorPoint = new { lat = 41.46, lon = -8.27 },
                      resources = new[] { new { resourceType = "vehicle", resourceId = vehicle, personnel = 4, responsibility = "firefighting" } } },
                new { type = "custom", id = "a-02", title = "Informar", organizationId = org, dependsOn = new[] { "a-01" } },
            },
        };
        var a = await Send(HttpMethod.Post, "/plans", Plan("A"), HttpStatusCode.Created); var b = await Send(HttpMethod.Post, "/plans", Plan("B"), HttpStatusCode.Created);
        Assert.Equal("proposed", Str(a, "status"));
        Assert.True(a["validation"]!["valid"]!.GetValue<bool>());

        await Send(HttpMethod.Post, "/plans", new { locationId = "nowhere", title = "x", actions = Array.Empty<object>() }, HttpStatusCode.UnprocessableEntity);
        var invalid = await Send(HttpMethod.Post, "/plans/validate", new { locationId = "guimaraes", title = "x", actions = new object[] { new { type = "custom", id = "a", title = "t", organizationId = org, dependsOn = new[] { "a" } } } }, HttpStatusCode.OK);
        Assert.False(invalid["valid"]!.GetValue<bool>());

        await Send(HttpMethod.Post, $"/plans/{Str(a, "id")}/activate", expect: HttpStatusCode.Conflict); // ainda não foi escolhido
        await Send(HttpMethod.Post, $"/plans/{Str(a, "id")}/select", expect: HttpStatusCode.OK);
        Assert.Equal("proposed", Str(await Send(HttpMethod.Get, $"/plans/{Str(b, "id")}", expect: HttpStatusCode.OK), "status")); // sem simulação ou cenário em comum, o B fica como está
        await Send(HttpMethod.Post, $"/plans/{Str(a, "id")}/activate", expect: HttpStatusCode.OK);
        Assert.Equal("dispatched", Str(await Send(HttpMethod.Get, $"/vehicles/{vehicle}/state", expect: HttpStatusCode.OK), "status"));
        Assert.Equal(1, (await Send(HttpMethod.Get, $"/actions?organizationId={org}&type=fire_attack", expect: HttpStatusCode.OK))["total"]!.GetValue<int>());
        Assert.Equal("in_progress", Str(await Send(HttpMethod.Patch, $"/plans/{Str(a, "id")}/actions/a-01", new { status = "in_progress", note = "a caminho" }, HttpStatusCode.OK), "status"));

        await Send(HttpMethod.Delete, $"/plans/{Str(a, "id")}", expect: HttpStatusCode.Conflict); // ativo: não se apaga

        await Send(HttpMethod.Patch, $"/plans/{Str(a, "id")}", new { status = "completed" }, HttpStatusCode.OK);
        Assert.Equal("available", Str(await Send(HttpMethod.Get, $"/vehicles/{vehicle}/state", expect: HttpStatusCode.OK), "status")); // fechar o plano liberta os meios
        await Send(HttpMethod.Patch, $"/plans/{Str(a, "id")}", new { title = "tarde demais" }, HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task A_fuel_break_plan_is_validated_for_crew_safety_and_location_and_the_action_type_is_a_capability()
    {
        var org = await Org(); var vehicle = await Vehicle(org, "VFCI-09");
        static object Line(double lat, double lon) => new { type = "LineString", coordinates = new[] { new[] { lon, lat }, new[] { lon + 0.002, lat + 0.001 } } };
        object Plan(object line, object[]? resources = null) => new
        {
            locationId = "guimaraes", title = "Faixa", actions = new object[] { new { type = "fuel_break", id = "fb-1", title = "Cortar eucaliptos", organizationId = org, line, removal = "trees", widthM = 25, resources } },
        };
        string[] codes(JsonNode v) => v["issues"]!.AsArray().Select(i => Str(i!.AsObject(), "code")).ToArray();

        var bare = await Send(HttpMethod.Post, "/plans/validate", Plan(Line(41.46, -8.27)), HttpStatusCode.OK);
        Assert.True(bare["valid"]!.GetValue<bool>());
        Assert.Contains("fuel_break_no_crew", codes(bare)); Assert.Contains("missing_safety", codes(bare));

        var crewed = await Send(HttpMethod.Post, "/plans/validate", Plan(Line(41.46, -8.27), new object[] { new { resourceType = "vehicle", resourceId = vehicle, personnel = 4, responsibility = "firefighting" } }), HttpStatusCode.OK);
        Assert.DoesNotContain("fuel_break_no_crew", codes(crewed));

        var outside = await Send(HttpMethod.Post, "/plans/validate", Plan(Line(10, 10)), HttpStatusCode.OK);
        Assert.False(outside["valid"]!.GetValue<bool>()); Assert.Contains("outside_location", codes(outside));

        var caps = await Send(HttpMethod.Get, "/capabilities", expect: HttpStatusCode.OK);
        Assert.Contains(caps["actionTypes"]!.AsArray(), a => Str(a!.AsObject(), "name") == "fuel_break");
        Assert.Contains(caps["interventions"]!.AsArray(), a => Str(a!.AsObject(), "name") == "fuel_removal");
    }
}
