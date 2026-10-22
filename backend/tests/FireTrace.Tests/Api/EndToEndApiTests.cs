using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Weather;
using FireTrace.Core.Models.Weather;
using FireTrace.Core.Serialization;
using FireTrace.Core.Services.Weather;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Api;

/// <summary>
/// End-to-end integration tests exercising the FireTrace API endpoints
/// and validating realistic multi-agency incident response scenarios.
/// </summary>
public class EndToEndApiTests : IClassFixture<ApiFactory>
{
    readonly HttpClient _http;
    public EndToEndApiTests(ApiFactory factory) => _http = factory.CreateClient();

    async Task<(HttpStatusCode status, JsonNode? body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, "/api/v1" + path);
        if (body is not null)
        {
            var json = body is string s ? s : JsonSerializer.Serialize(body, ApiJson.Options);
            request.Content = new StringContent(json, System.Text.Encoding.UTF8, method == HttpMethod.Patch ? "application/merge-patch+json" : "application/json");
        }
        var response = await _http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        JsonNode? node = null;
        if (!string.IsNullOrWhiteSpace(text))
        {
            try { node = JsonNode.Parse(text); } catch { }
        }
        return (response.StatusCode, node);
    }

    static string Str(JsonNode? node, string key) => node?[key]?.GetValue<string>() ?? string.Empty;
    static int Int(JsonNode? node, string key) => node?[key]?.GetValue<int>() ?? 0;

    [Fact]
    public async Task Meta_endpoints_return_system_status_and_contract()
    {
        // 1. Health check
        var (healthStatus, health) = await Send(HttpMethod.Get, "/health");
        Assert.Equal(HttpStatusCode.OK, healthStatus);
        Assert.NotNull(health);
        Assert.True(health["status"] is not null);

        // 2. Capabilities
        var (capStatus, caps) = await Send(HttpMethod.Get, "/capabilities");
        Assert.Equal(HttpStatusCode.OK, capStatus);
        Assert.NotNull(caps?["engine"]);
        Assert.NotNull(caps?["actionTypes"]);
        Assert.NotNull(caps?["interventions"]);

        // 3. Operational Rules
        var (rulesStatus, rules) = await Send(HttpMethod.Get, "/rules");
        Assert.Equal(HttpStatusCode.OK, rulesStatus);
        Assert.NotNull(rules?["movement"]);
        Assert.NotNull(rules?["water"]);
        Assert.NotNull(rules?["crews"]);

        // 4. OpenAPI Contract Specification
        var (specStatus, spec) = await Send(HttpMethod.Get, "/openapi.json");
        Assert.Equal(HttpStatusCode.OK, specStatus);
        Assert.Equal("3.1.0", Str(spec, "openapi"));
    }

    [Fact]
    public async Task Locations_and_geospatial_layers_are_accessible_and_queryable()
    {
        // 1. Locations list
        var (locsStatus, locs) = await Send(HttpMethod.Get, "/locations");
        Assert.Equal(HttpStatusCode.OK, locsStatus);
        var locItems = locs?["items"]?.AsArray();
        Assert.NotNull(locItems);
        Assert.Contains(locItems, l => Str(l, "id") == "guimaraes");

        // 2. Location detail
        var (locStatus, loc) = await Send(HttpMethod.Get, "/locations/guimaraes");
        Assert.Equal(HttpStatusCode.OK, locStatus);
        Assert.Equal("guimaraes", Str(loc, "id"));
        Assert.NotNull(loc?["bounds"]);
        Assert.NotNull(loc?["elevationM"]);

        // 3. Facilities
        var (facStatus, facilities) = await Send(HttpMethod.Get, "/locations/guimaraes/facilities?limit=10");
        Assert.Equal(HttpStatusCode.OK, facStatus);
        Assert.NotNull(facilities?["items"]);

        // 4. Water Points & Nearby Water Search
        var (wpStatus, waterPoints) = await Send(HttpMethod.Get, "/locations/guimaraes/water-points?limit=5");
        Assert.Equal(HttpStatusCode.OK, wpStatus);
        Assert.NotNull(waterPoints?["items"]);

        var (nearStatus, nearWp) = await Send(HttpMethod.Get, "/locations/guimaraes/water-points/near?lat=41.4425&lon=-8.2918&radiusM=5000&limit=5");
        Assert.Equal(HttpStatusCode.OK, nearStatus);
        Assert.NotNull(nearWp?["items"]);

        // 5. Roads GeoJSON
        var (roadsStatus, roads) = await Send(HttpMethod.Get, "/locations/guimaraes/roads");
        Assert.Equal(HttpStatusCode.OK, roadsStatus);
        Assert.Equal("FeatureCollection", Str(roads, "type"));

        // 6. Firebreaks GeoJSON
        var (fbStatus, firebreaks) = await Send(HttpMethod.Get, "/locations/guimaraes/firebreaks");
        Assert.Equal(HttpStatusCode.OK, fbStatus);
        Assert.Equal("FeatureCollection", Str(firebreaks, "type"));

        // 7. Vegetation breakdown
        var (vegStatus, veg) = await Send(HttpMethod.Get, "/locations/guimaraes/vegetation");
        Assert.Equal(HttpStatusCode.OK, vegStatus);
        Assert.NotNull(veg?["classes"]);

        // 8. Buildings
        var (bldStatus, buildings) = await Send(HttpMethod.Get, "/locations/guimaraes/buildings?limit=10");
        Assert.Equal(HttpStatusCode.OK, bldStatus);
        Assert.NotNull(buildings?["features"]);

        // 9. Terrain at coordinate
        var (terStatus, terrain) = await Send(HttpMethod.Get, "/locations/guimaraes/terrain-at?lat=41.4425&lon=-8.2918");
        Assert.Equal(HttpStatusCode.OK, terStatus);
        Assert.NotNull(terrain?["elevationM"]);

        // 10. Area stats calculation
        var polygon = new
        {
            type = "Polygon",
            coordinates = new[]
            {
                new[] { new[] { -8.30, 41.43 }, new[] { -8.28, 41.43 }, new[] { -8.28, 41.45 }, new[] { -8.30, 41.45 }, new[] { -8.30, 41.43 } }
            }
        };
        var (areaStatus, areaStats) = await Send(HttpMethod.Post, "/locations/guimaraes/area-stats", new { geometry = polygon });
        Assert.Equal(HttpStatusCode.OK, areaStatus);
        Assert.True(areaStats?["areaHa"]?.GetValue<double>() > 0);

        // 11. Resource summary and deployment overview
        var (resStatus, summary) = await Send(HttpMethod.Get, "/locations/guimaraes/resources/summary");
        Assert.Equal(HttpStatusCode.OK, resStatus);
        Assert.NotNull(summary?["overall"]);

        var (depStatus, deployment) = await Send(HttpMethod.Get, "/locations/guimaraes/deployment");
        Assert.Equal(HttpStatusCode.OK, depStatus);
        Assert.NotNull(deployment?["byResponsibility"]);
        Assert.NotNull(deployment?["idle"]);
    }

    [Fact]
    public async Task Operational_resources_CRUD_lifecycle()
    {
        // 1. Organization lifecycle
        var (createOrgStatus, org) = await Send(HttpMethod.Post, "/organizations", new
        {
            name = "Proteção Civil Municipal de Teste",
            shortName = "SMPCT",
            type = "civil_protection",
            active = true
        });
        Assert.Equal(HttpStatusCode.Created, createOrgStatus);
        var orgId = Str(org, "id");
        Assert.StartsWith("org-", orgId);

        var (getOrgStatus, fetchedOrg) = await Send(HttpMethod.Get, $"/organizations/{orgId}");
        Assert.Equal(HttpStatusCode.OK, getOrgStatus);
        Assert.Equal("SMPCT", Str(fetchedOrg, "shortName"));

        // 2. Station lifecycle
        var (createStStatus, station) = await Send(HttpMethod.Post, "/stations", new
        {
            organizationId = orgId,
            name = "Posto de Comando Avançado",
            kind = "civil_protection_hq",
            locationId = "guimaraes",
            position = new { lat = 41.4425, lon = -8.2918 },
            vehicleBays = 4,
            status = "operational"
        });
        Assert.Equal(HttpStatusCode.Created, createStStatus);
        var stationId = Str(station, "id");

        // 3. Vehicle lifecycle
        var (createVehStatus, vehicle) = await Send(HttpMethod.Post, "/vehicles", new
        {
            organizationId = orgId,
            stationId = stationId,
            callsign = "PCO-TESTE",
            type = "command_vehicle",
            crewCapacity = 4,
            minimumCrew = 2,
            offRoad = true,
            capabilities = new[] { "command_and_control", "communications" }
        });
        Assert.Equal(HttpStatusCode.Created, createVehStatus);
        var vehicleId = Str(vehicle, "id");

        // Vehicle state inspection and patch
        var (getStateStatus, state) = await Send(HttpMethod.Get, $"/vehicles/{vehicleId}/state");
        Assert.Equal(HttpStatusCode.OK, getStateStatus);
        Assert.Equal("available", Str(state, "status"));

        var (patchStateStatus, patchedState) = await Send(HttpMethod.Patch, $"/vehicles/{vehicleId}/state", new
        {
            status = "assigned",
            crewOnboard = 3
        });
        Assert.Equal(HttpStatusCode.OK, patchStateStatus);
        Assert.Equal("assigned", Str(patchedState, "status"));
        Assert.Equal(3, Int(patchedState, "crewOnboard"));

        // 4. Equipment lifecycle
        var (createEqStatus, eq) = await Send(HttpMethod.Post, "/equipment", new
        {
            organizationId = orgId,
            kind = "road_barrier",
            label = "Barreiras Sinalizadoras",
            quantity = 20,
            available = 20
        });
        Assert.Equal(HttpStatusCode.Created, createEqStatus);
        var eqId = Str(eq, "id");

        // 5. Personnel pool lifecycle
        var (createPoolStatus, pool) = await Send(HttpMethod.Post, "/personnel-pools", new
        {
            organizationId = orgId,
            role = "civil_protection_technician",
            total = 10,
            available = 10
        });
        Assert.Equal(HttpStatusCode.Created, createPoolStatus);
        var poolId = Str(pool, "id");

        // 6. Road closures lifecycle
        var (createCloStatus, closure) = await Send(HttpMethod.Post, "/road-closures", new
        {
            locationId = "guimaraes",
            geometry = new { type = "LineString", coordinates = new[] { new[] { -8.2918, 41.4425 }, new[] { -8.2900, 41.4430 } } },
            kind = "partial_lane",
            reason = "traffic_management",
            start = DateTimeOffset.UtcNow.ToString("O"),
            responsibleOrganizationId = orgId
        });
        Assert.Equal(HttpStatusCode.Created, createCloStatus);
        var closureId = Str(closure, "id");

        var (patchCloStatus, patchedClo) = await Send(HttpMethod.Patch, $"/road-closures/{closureId}", new
        {
            status = "lifted"
        });
        Assert.Equal(HttpStatusCode.OK, patchCloStatus);
        Assert.Equal("lifted", Str(patchedClo, "status"));

        // Clean-up entities in dependency order
        await Send(HttpMethod.Delete, $"/personnel-pools/{poolId}");
        await Send(HttpMethod.Delete, $"/equipment/{eqId}");
        await Send(HttpMethod.Delete, $"/vehicles/{vehicleId}");
        await Send(HttpMethod.Delete, $"/stations/{stationId}");
        await Send(HttpMethod.Delete, $"/organizations/{orgId}");
    }

    [Fact]
    public async Task Routing_and_weather_endpoints_calculate_correctly()
    {
        // 1. Weather preview from manual keyframes (the OpenAPI recipe, without Open-Meteo)
        var (resolveStatus, resolved) = await Send(HttpMethod.Post, "/weather/resolve", new
        {
            locationId = "guimaraes",
            start = "2026-08-17T12:00:00Z",
            durationMinutes = 120,
            stepMinutes = 30,
            weather = new
            {
                @base = "none",
                keyframes = new[]
                {
                    new { at = new { offsetMinutes = 0 }, windKmh = 35, windFromDeg = 335, gustKmh = 55, tempC = 34, humidityPct = 18, precipitationMmH = 0 },
                    new { at = new { offsetMinutes = 120 }, windKmh = 35, windFromDeg = 335, gustKmh = 45, tempC = 31, humidityPct = 22, precipitationMmH = 0 },
                },
            },
        });
        Assert.Equal(HttpStatusCode.OK, resolveStatus);
        var samples = resolved?["samples"]?.AsArray();
        Assert.NotNull(samples);
        Assert.Equal(35, samples[0]?["windKmh"]?.GetValue<double>());
        Assert.Equal(55, samples[0]?["gustKmh"]?.GetValue<double>());
        Assert.Equal(34, samples[0]?["tempC"]?.GetValue<double>());
        Assert.Equal(18, samples[0]?["humidityPct"]?.GetValue<double>());
        Assert.Equal(22, samples[^1]?["humidityPct"]?.GetValue<double>());
        Assert.Null(samples[0]?["precipitationMmH"]);

        // 3. Routing calculation
        var (routeStatus, route) = await Send(HttpMethod.Post, "/routing/route", new
        {
            locationId = "guimaraes",
            from = new { lat = 41.4425, lon = -8.2918 },
            to = new { lat = 41.4500, lon = -8.2800 },
            vehicleProfile = "light_truck"
        });
        Assert.Equal(HttpStatusCode.OK, routeStatus);
        Assert.True(route?["durationMin"]?.GetValue<double>() > 0);
        Assert.NotNull(route?["geometry"]);

        // 4. Access matrix calculation
        var (accessStatus, access) = await Send(HttpMethod.Post, "/routing/access", new
        {
            locationId = "guimaraes",
            origins = new[] { new { position = new { lat = 41.4425, lon = -8.2918 } } }
        });
        Assert.Equal(HttpStatusCode.OK, accessStatus);
        Assert.NotNull(access?["entries"]);
    }

    [Fact]
    public async Task Weather_resolve_echoes_the_applied_recipe_and_matches_the_engine_track()
    {
        // A receita cobre os pontos-chave e todos os tipos de evento: a pré-visualização tem de ser exatamente a série que o motor constrói.
        var request = new
        {
            locationId = "guimaraes",
            start = "2026-08-17T12:00:00Z",
            durationMinutes = 180,
            stepMinutes = 15,
            weather = new
            {
                @base = "none",
                keyframes = new object[]
                {
                    new { at = new { offsetMinutes = 0 }, windKmh = 10.0, windFromDeg = 180.0, tempC = 30.0, humidityPct = 40.0 },
                    new { at = new { offsetMinutes = 60 }, windKmh = 12.0, tempC = 32.0 },
                },
                events = new object[]
                {
                    new { type = "wind_set", window = new { start = new { offsetMinutes = 0 }, end = new { offsetMinutes = 30 } }, windKmh = 25.0, windFromDeg = 200.0, rampMinutes = 5 },
                    new { type = "wind_shift", start = new { offsetMinutes = 40 }, toDeg = 300.0, rampMinutes = 10, holdMinutes = 20, returnRampMinutes = 10 },
                    new { type = "wind_scale", window = new { start = new { offsetMinutes = 60 }, end = new { offsetMinutes = 90 } }, factor = 1.5, rampMinutes = 5, applyToGusts = true },
                    new { type = "gust_burst", window = new { start = new { offsetMinutes = 100 }, end = new { offsetMinutes = 110 } }, peakGustKmh = 80.0, periodMinutes = 5.0 },
                    new { type = "front_passage", at = new { offsetMinutes = 120 }, durationMinutes = 20, windKmh = 40.0, windFromDeg = 270.0, tempDeltaC = -6.0, humidityDeltaPct = 30.0, precipitationMmH = 4.0 },
                    new { type = "temperature_shift", window = new { start = new { offsetMinutes = 140 }, end = new { offsetMinutes = 160 } }, deltaC = 5.0, rampMinutes = 5 },
                    new { type = "humidity_shift", window = new { start = new { offsetMinutes = 140 }, end = new { offsetMinutes = 160 } }, deltaPct = -15.0, rampMinutes = 5 },
                    new { type = "precipitation", window = new { start = new { offsetMinutes = 165 }, end = new { offsetMinutes = 180 } }, intensityMmH = 8.0, rampMinutes = 5 },
                    new { type = "precipitation", enabled = false, window = new { start = new { offsetMinutes = 0 }, end = new { offsetMinutes = 180 } }, intensityMmH = 99.0 },
                },
            },
        };
        var (status, resolved) = await Send(HttpMethod.Post, "/weather/resolve", request);
        Assert.Equal(HttpStatusCode.OK, status);

        // Eco: só os eventos ativos, na ordem aplicada, e os pontos-chave.
        var echoed = resolved?["events"]?.AsArray();
        Assert.NotNull(echoed);
        Assert.Equal(8, echoed.Count);
        Assert.Equal("wind_set", Str(echoed[0], "type"));
        Assert.Equal("precipitation", Str(echoed[echoed.Count - 1], "type"));
        Assert.Equal(2, resolved?["keyframes"]?.AsArray().Count ?? 0);

        // A mesma receita, pelo mesmo caminho do motor (`WeatherTimeline.Build`), dá os mesmos valores.
        var dto = JsonSerializer.Deserialize<WeatherResolveRequest>(JsonSerializer.Serialize(request, ApiJson.Options), ApiJson.Options)!;
        var track = WeatherTimeline.Build(dto.Weather, Array.Empty<WeatherSample>(), dto.Start, dto.DurationMinutes, TestSettings.All.Weather.Timeline, 0, new LatLon(41.44, -8.29));
        var samples = resolved!["samples"]!.AsArray();
        var step = dto.StepMinutes ?? 15;
        Assert.Equal(dto.DurationMinutes / step + 1, samples.Count);
        for (var i = 0; i < samples.Count; i++)
        {
            var p = track.At(i * step);
            Assert.Equal(Math.Round(p.WindKmh, 1), samples[i]!["windKmh"]!.GetValue<double>(), 1);
            Assert.Equal(Math.Round(p.WindFromDeg), samples[i]!["windFromDeg"]!.GetValue<double>(), 0);
            Assert.Equal(Math.Round(p.TempC, 1), samples[i]!["tempC"]!.GetValue<double>(), 1);
            Assert.Equal(Math.Round(p.HumidityPct), samples[i]!["humidityPct"]!.GetValue<double>(), 0);
            var gust = samples[i]?["gustKmh"]?.GetValue<double>() ?? 0;
            Assert.Equal(p.GustKmh > 0 ? Math.Round(p.GustKmh, 1) : 0, gust, 1);
            var rain = samples[i]?["precipitationMmH"]?.GetValue<double>() ?? 0;
            Assert.Equal(p.PrecipitationMmH > 0 ? Math.Round(p.PrecipitationMmH, 1) : 0, rain, 1);
        }
    }

    [Fact]
    public async Task Manual_custom_series_is_accepted_without_keyframes()
    {
        var (status, resolved) = await Send(HttpMethod.Post, "/weather/resolve", new
        {
            locationId = "guimaraes",
            start = "2026-08-17T12:00:00Z",
            durationMinutes = 60,
            stepMinutes = 30,
            weather = new
            {
                @base = "none",
                events = new[]
                {
                    new
                    {
                        type = "custom_series",
                        samples = new[]
                        {
                            new { time = "2026-08-17T12:00:00Z", windKmh = 15, windFromDeg = 300, gustKmh = 30, tempC = 30, humidityPct = 30, precipitationMmH = 0.0 },
                            new { time = "2026-08-17T13:00:00Z", windKmh = 25, windFromDeg = 310, gustKmh = 45, tempC = 32, humidityPct = 25, precipitationMmH = 1.2 },
                        },
                    },
                },
            },
        });
        Assert.Equal(HttpStatusCode.OK, status);
        var samples = resolved?["samples"]?.AsArray();
        Assert.NotNull(samples);
        Assert.Equal(15, samples[0]?["windKmh"]?.GetValue<double>());
        Assert.Equal(20, samples[1]?["windKmh"]?.GetValue<double>());
        Assert.Equal(37.5, samples[1]?["gustKmh"]?.GetValue<double>());
        Assert.Equal(0.6, samples[1]?["precipitationMmH"]?.GetValue<double>());
    }

    [Fact]
    public async Task Scenarios_CRUD_and_query_endpoints()
    {
        // 1. Create custom training scenario
        var (createStatus, sc) = await Send(HttpMethod.Post, "/scenarios", new
        {
            name = "Cenário de Teste E2E",
            description = "Exercício de validação de rota e recursos",
            locationId = "guimaraes",
            purpose = "exercise",
            start = "2026-08-20T14:00:00+01:00",
            durationMinutes = 120,
            ignitions = new[] { new { position = new { lat = 41.44, lon = -8.29 }, label = "Foco Teste" } },
            weather = new
            {
                @base = "none",
                keyframes = new[]
                {
                    new { at = new { offsetMinutes = 0 }, windKmh = 20, windFromDeg = 335, gustKmh = 40, tempC = 35, humidityPct = 17, precipitationMmH = 0.0 },
                },
            },
        });
        Assert.Equal(HttpStatusCode.Created, createStatus);
        var scId = Str(sc, "id");
        Assert.Equal("none", Str(sc?["weather"], "base"));
        var keyframe = sc?["weather"]?["keyframes"]?.AsArray();
        Assert.NotNull(keyframe);
        Assert.Equal(40, keyframe[0]?["gustKmh"]?.GetValue<double>());
        Assert.Equal(35, keyframe[0]?["tempC"]?.GetValue<double>());

        // 2. List scenarios and verify created scenario is included
        var (listStatus, scenarios) = await Send(HttpMethod.Get, "/scenarios");
        Assert.Equal(HttpStatusCode.OK, listStatus);
        var items = scenarios?["items"]?.AsArray();
        Assert.NotNull(items);
        Assert.NotEmpty(items);

        var (getScStatus, fetchedSc) = await Send(HttpMethod.Get, $"/scenarios/{scId}");
        Assert.Equal(HttpStatusCode.OK, getScStatus);
        Assert.Equal("Cenário de Teste E2E", Str(fetchedSc, "name"));

        var (patchStatus, patchedSc) = await Send(HttpMethod.Patch, $"/scenarios/{scId}", new
        {
            description = "Descrição atualizada"
        });
        Assert.Equal(HttpStatusCode.OK, patchStatus);
        Assert.Equal("Descrição atualizada", Str(patchedSc, "description"));
        Assert.Equal("none", Str(patchedSc?["weather"], "base"));

        await Send(HttpMethod.Delete, $"/scenarios/{scId}");
    }

    [Fact]
    public async Task Complete_operational_incident_response_scenario_flow()
    {
        // Setup participating emergency organization and tactical assets
        var (_, org) = await Send(HttpMethod.Post, "/organizations", new { name = "Bombeiros E2E", type = "fire_brigade" });
        var orgId = Str(org, "id");

        var (_, station) = await Send(HttpMethod.Post, "/stations", new
        {
            organizationId = orgId,
            name = "Quartel E2E",
            kind = "fire_station",
            locationId = "guimaraes",
            position = new { lat = 41.445, lon = -8.295 }
        });
        var stationId = Str(station, "id");

        var (_, vehicle) = await Send(HttpMethod.Post, "/vehicles", new
        {
            organizationId = orgId,
            stationId,
            callsign = "VFCI-E2E",
            type = "forest_firefighting_vehicle",
            crewCapacity = 5,
            minimumCrew = 3,
            waterCapacityL = 3500,
            offRoad = true,
            capabilities = new[] { "wildfire_attack", "structure_protection" }
        });
        var vehicleId = Str(vehicle, "id");

        // 1. Propose Plan A with Fire Attack Action
        var planBody = new
        {
            locationId = "guimaraes",
            title = "Plano E2E — Ataque Inicial Penha",
            variant = "A",
            strategy = "Ataque direto ao flanco com ancoragem segura",
            actions = new object[]
            {
                new
                {
                    type = "fire_attack",
                    id = "act-e2e-01",
                    title = "Ataque direto ao flanco norte",
                    organizationId = orgId,
                    priority = "critical",
                    tactic = "direct_attack",
                    anchorPoint = new { lat = 41.43, lon = -8.27 },
                    resources = new[]
                    {
                        new { resourceType = "vehicle", resourceId = vehicleId, personnel = 5, responsibility = "firefighting" }
                    }
                }
            }
        };

        // 2. Validate proposed plan
        var (valStatus, validation) = await Send(HttpMethod.Post, "/plans/validate", planBody);
        Assert.Equal(HttpStatusCode.OK, valStatus);
        Assert.True(validation?["valid"]?.GetValue<bool>());

        // 3. Publish Plan
        var (createPlanStatus, plan) = await Send(HttpMethod.Post, "/plans", planBody);
        Assert.Equal(HttpStatusCode.Created, createPlanStatus);
        var planId = Str(plan, "id");
        Assert.Equal("proposed", Str(plan, "status"));

        // 4. Operator selects Plan
        var (selectStatus, selectedPlan) = await Send(HttpMethod.Post, $"/plans/{planId}/select");
        Assert.Equal(HttpStatusCode.OK, selectStatus);
        Assert.Equal("selected", Str(selectedPlan, "status"));

        // 5. Incident Commander activates Plan
        var (activateStatus, activePlan) = await Send(HttpMethod.Post, $"/plans/{planId}/activate");
        Assert.Equal(HttpStatusCode.OK, activateStatus);
        Assert.Equal("active", Str(activePlan, "status"));

        // 6. Check that active action appears on organization's task list
        var (actionsStatus, actions) = await Send(HttpMethod.Get, $"/actions?organizationId={orgId}");
        Assert.Equal(HttpStatusCode.OK, actionsStatus);
        var actionItems = actions?["items"]?.AsArray();
        Assert.NotNull(actionItems);
        Assert.Contains(actionItems, a => Str(a?["action"], "id") == "act-e2e-01");

        // 7. Verify vehicle status was automatically updated to dispatched/assigned
        var (vehStateStatus, vehState) = await Send(HttpMethod.Get, $"/vehicles/{vehicleId}/state");
        Assert.Equal(HttpStatusCode.OK, vehStateStatus);
        Assert.Equal("dispatched", Str(vehState, "status"));

        // 8. Update action progress on scene
        var (patchActStatus, patchedAct) = await Send(HttpMethod.Patch, $"/plans/{planId}/actions/act-e2e-01", new
        {
            status = "in_progress",
            note = "Linha de mangueira ancorada e em progressão"
        });
        Assert.Equal(HttpStatusCode.OK, patchActStatus);
        Assert.Equal("in_progress", Str(patchedAct, "status"));

        // 9. Conclude incident and release resources
        var (completePlanStatus, completedPlan) = await Send(HttpMethod.Patch, $"/plans/{planId}", new
        {
            status = "completed"
        });
        Assert.Equal(HttpStatusCode.OK, completePlanStatus);
        Assert.Equal("completed", Str(completedPlan, "status"));

        // 10. Verify vehicle is freed and available again
        var (_, freedVehState) = await Send(HttpMethod.Get, $"/vehicles/{vehicleId}/state");
        Assert.Equal("available", Str(freedVehState, "status"));

        // Clean-up
        await Send(HttpMethod.Delete, $"/vehicles/{vehicleId}");
        await Send(HttpMethod.Delete, $"/stations/{stationId}");
        await Send(HttpMethod.Delete, $"/organizations/{orgId}");
    }
}
