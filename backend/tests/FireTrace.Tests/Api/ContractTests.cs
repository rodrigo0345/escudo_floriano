using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Plans.Actions;
using FireTrace.Core.Domain.Plans;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.RoadClosures;
using FireTrace.Core.Domain.Scenarios;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Map;
using FireTrace.Core.Models.Operations;
using FireTrace.Core.Models.Routing;
using FireTrace.Core.Models.Weather;
using FireTrace.Core.Serialization;
using FireTrace.Core.Services.Crud;
using Json.Schema;

namespace FireTrace.Tests.Api;

/// <summary>
/// `api-spec/openapi.json` é a fonte de verdade: cada exemplo de pedido tem de ser lido pelos DTOs sem perder campos
/// (os campos desconhecidos são erro) e de voltar a escrever-se de forma que o contrato aceita.
/// </summary>
public class ContractTests
{
    public static readonly string SpecPath = FindSpec();
    static readonly JsonNode Spec = JsonNode.Parse(File.ReadAllText(SpecPath))!;

    static string FindSpec()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "api-spec", "openapi.json"))) return Path.Combine(d.FullName, "api-spec", "openapi.json");
        throw new FileNotFoundException("api-spec/openapi.json não encontrado");
    }

    /// <summary>Que tipo C# representa cada schema de pedido do contrato.</summary>
    static readonly Dictionary<string, Type> Dtos = new()
    {
        ["DispatchBatchInput"] = typeof(DispatchBatch), ["DispatchPatch"] = typeof(DispatchPatch), ["EquipmentInput"] = typeof(Equipment), ["AreaStatsRequest"] = typeof(AreaStatsRequest),
        ["OrganizationInput"] = typeof(Organization), ["PersonnelPoolInput"] = typeof(PersonnelPool), ["PlanInput"] = typeof(Plan), ["ActionPatch"] = typeof(ActionPatch),
        ["RoadClosureInput"] = typeof(RoadClosure), ["RouteRequest"] = typeof(RouteRequest), ["ScenarioInput"] = typeof(Scenario), ["SimulationRequest"] = typeof(SimulationRequest),
        ["StationInput"] = typeof(Station), ["VehicleInput"] = typeof(Vehicle), ["VehicleStatePatch"] = typeof(VehicleState), ["WeatherResolveRequest"] = typeof(WeatherResolveRequest),
    };

    public static IEnumerable<object[]> Examples()
    {
        foreach (var (path, item) in Spec["paths"]!.AsObject())
            foreach (var (method, op) in item!.AsObject())
                if (op is JsonObject o && o["requestBody"]?["content"]?.AsObject() is { } content)
                    foreach (var (_, media) in content)
                    {
                        if (media?["schema"]?["$ref"]?.GetValue<string>().Split('/')[^1] is not { } schema || !Dtos.ContainsKey(schema)) continue;
                        var examples = media["example"] is { } single ? new[] { single } : (media["examples"]?.AsObject().Select(e => e.Value?["value"]).OfType<JsonNode>() ?? Enumerable.Empty<JsonNode>());
                        foreach (var example in examples) yield return new object[] { $"{method.ToUpperInvariant()} {path}", schema, example.ToJsonString() };
                    }
    }

    [Fact]
    public void Every_request_with_an_example_is_covered_by_a_dto() => Assert.True(Examples().Count() >= 15);

    [Theory]
    [MemberData(nameof(Examples))]
    public void Request_examples_survive_a_round_trip_through_the_dtos(string operation, string schemaName, string json)
    {
        var strict = new JsonSerializerOptions(ApiJson.Options) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
        var type = Dtos[schemaName];

        object dto = schemaName == "VehicleStatePatch"
            ? MergePatch.Apply(new VehicleState(), JsonDocument.Parse(json).RootElement)   // PATCH com merge: parte do estado vazio
            : JsonSerializer.Deserialize(json, type, strict)!;
        var back = JsonSerializer.SerializeToNode(dto, type, ApiJson.Options)!;

        var missing = Missing(JsonNode.Parse(json)!, back, "").ToList(); // nada do que o exemplo diz se pode perder
        Assert.True(missing.Count == 0, $"{operation}: o exemplo perdeu {string.Join(", ", missing)} ao passar pelo DTO");
        AssertValid(schemaName, json);                             // o exemplo cumpre o próprio contrato
        if (!schemaName.EndsWith("Patch")) AssertValid(schemaName, back.ToJsonString()); // e o que a API escreveria também
    }

    /// <summary>Caminhos do exemplo que não aparecem (com o mesmo valor) no resultado.</summary>
    static IEnumerable<string> Missing(JsonNode expected, JsonNode? actual, string path)
    {
        switch (expected)
        {
            case JsonObject eo:
                foreach (var (k, v) in eo)
                {
                    if (v is null) continue; // null no exemplo = campo ausente
                    if (actual is not JsonObject ao || !ao.TryGetPropertyValue(k, out var av) || av is null) { yield return $"{path}/{k}"; continue; }
                    foreach (var m in Missing(v, av, $"{path}/{k}")) yield return m;
                }
                break;
            case JsonArray ea:
                if (actual is not JsonArray aa || aa.Count != ea.Count) { yield return path + "[]"; break; }
                for (int i = 0; i < ea.Count; i++) foreach (var m in Missing(ea[i]!, aa[i], $"{path}[{i}]")) yield return m;
                break;
            case JsonValue ev:
                if (actual is not JsonValue av2 || !SameValue(ev, av2)) yield return $"{path} ({ev.ToJsonString()} ≠ {actual?.ToJsonString()})";
                break;
        }
    }

    static bool SameValue(JsonValue a, JsonValue b)
    {
        if (a.TryGetValue<string>(out var sa) && b.TryGetValue<string>(out var sb))
            return sa == sb || (DateTimeOffset.TryParse(sa, out var da) && DateTimeOffset.TryParse(sb, out var db) && da == db);
        if (a.TryGetValue<double>(out var na) && b.TryGetValue<double>(out var nb)) return Math.Abs(na - nb) < 1e-9;
        return a.ToJsonString() == b.ToJsonString();
    }

    static void AssertValid(string schemaName, string json)
    {
        // o schema referencia `#/components/...`, por isso avalia-se dentro de um documento que inclui o contrato
        var wrapper = new JsonObject { ["$ref"] = $"#/components/schemas/{schemaName}", ["components"] = Spec["components"]!.DeepClone() };
        var schema = JsonSchema.FromText(wrapper.ToJsonString());
        var result = schema.Evaluate(JsonNode.Parse(json), new EvaluationOptions { OutputFormat = OutputFormat.List });
        Assert.True(result.IsValid, $"{schemaName} inválido: " + string.Join("; ", result.Details.Where(d => d.Errors is not null).SelectMany(d => d.Errors!.Select(e => $"{d.InstanceLocation} {e.Value}")).Take(5)));
    }
}
