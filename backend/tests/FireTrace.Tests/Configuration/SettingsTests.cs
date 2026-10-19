using System.Reflection;
using FireTrace.Core.Domain.Dispatches;
using FireTrace.Core.Domain.Resources;
using FireTrace.Core.Domain.Rules;
using FireTrace.Core.Domain.Simulations;
using FireTrace.Core.Models.Fire;
using FireTrace.Core.Models.Meta;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Configuration;

/// <summary>Os valores vivem em `appsettings.json` e `externaldata.settings.json`: têm de estar todos lá, ser coerentes entre si e com o código.</summary>
public class SettingsTests
{
    /// <summary>Todas as propriedades numéricas dos grupos de configuração (menos listas): um zero é uma chave que faltou no JSON, porque nenhuma pode ser zero.</summary>
    static IEnumerable<string> ZeroNumbers(object? node, string path)
    {
        if (node is null) { yield return path + " (em falta)"; yield break; }
        var type = node.GetType();
        if (type.IsPrimitive || type == typeof(string) || type.IsEnum || node is System.Collections.IEnumerable) yield break;
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0))
        {
            var value = p.GetValue(node);
            if (value is int i && i == 0 || value is double d && d == 0) yield return $"{path}.{p.Name}";
            else if (value is not null && !p.PropertyType.IsPrimitive) foreach (var z in ZeroNumbers(value, $"{path}.{p.Name}")) yield return z;
            else if (value is null && !(Nullable.GetUnderlyingType(p.PropertyType) is not null)) yield return $"{path}.{p.Name} (em falta)";
        }
    }

    [Fact]
    public void Every_api_setting_is_present_in_appsettings_json()
    {
        var s = TestSettings.All;
        var groups = new (string Name, object? Value)[]
        {
            ("Limits", s.Limits), ("Defaults", s.Defaults), ("Engine", s.Engine), ("Simulation", s.Simulation), ("Weather", s.Weather), ("Landscape", s.Landscape), ("Convection", s.Convection), ("FuelMoisture", s.FuelMoisture),
            ("Interventions", s.Interventions), ("Analytics", s.Analytics), ("Smoke", s.Smoke), ("Routing", s.Routing), ("Map", s.Map), ("RunStore", s.RunStore), ("Database", s.Database), ("Rules", s.Rules),
        };
        var missing = groups.SelectMany(g => ZeroNumbers(g.Value, g.Name)).ToList();
        Assert.True(missing.Count == 0, "faltam em appsettings.json: " + string.Join(", ", missing));
        Assert.NotEmpty(s.Dispatch.ResponsibilityCapabilities);
        Assert.NotEmpty(s.Landscape.Barriers.Roads);
        Assert.NotEmpty(s.Landscape.Barriers.Waterways);
    }

    [Fact]
    public void Every_external_data_setting_is_present_in_externaldata_settings_json()
    {
        var o = ExternalDataOptions.FromFile(Path.Combine(AppContext.BaseDirectory, ExternalDataOptions.FileName));
        var groups = new (string Name, object? Value)[] { ("Http", o.Http), ("Overpass", o.Overpass), ("Water", o.Water), ("Terrain", o.Terrain), ("Imagery", o.Imagery), ("Ortho", o.Ortho), ("LandCover", o.LandCover) };
        var missing = groups.SelectMany(g => ZeroNumbers(g.Value, g.Name)).ToList();
        Assert.True(missing.Count == 0, "faltam em externaldata.settings.json: " + string.Join(", ", missing));
        Assert.NotEmpty(o.Overpass.Endpoints); Assert.NotEmpty(o.Roads.PavedClasses); Assert.NotEmpty(o.Places.DefaultPopulation);
    }

    [Fact]
    public void Fuel_classes_match_the_land_cover_ids_the_map_stores()
    {
        var fuels = TestSettings.Fuels;
        Assert.Equal(LandCover.Count, fuels.Count);
        for (int id = 0; id < LandCover.Count; id++) Assert.Equal(LandCover.KeyOf(id), fuels.Get(id).Key);
    }

    [Fact]
    public void Every_world_cover_class_and_waterway_tag_in_the_map_settings_is_understood()
    {
        var o = ExternalDataOptions.FromFile(Path.Combine(AppContext.BaseDirectory, ExternalDataOptions.FileName));
        foreach (var key in o.LandCover.WorldCoverClasses.Values.Append(o.LandCover.WorldCoverDefaultClass).Append(o.LandCover.UniformClass)) Assert.True(LandCover.IdOf(key) > 0, key);
        foreach (var kind in o.Waterways.OsmWaterwayTags.Values) Assert.True(Enum.TryParse<WaterwayKind>(kind, ignoreCase: true, out _), kind);
        foreach (var kind in o.Waterways.BarrierKinds) Assert.True(EnumText.TryParse<WaterwayKind>(kind, out _), kind);
        Assert.All(Enum.GetValues<WaterwayKind>(), k => Assert.Contains(EnumText.ToSnake(k), TestSettings.All.Landscape.Barriers.Waterways.Keys)); // todo curso de água tem o seu fator
    }

    [Fact]
    public void Road_speeds_and_rules_cover_the_same_road_classes()
    {
        var rules = TestSettings.All.Rules.Movement.RoadSpeedFactor.Select(f => f.Highway).Order();
        Assert.Equal(rules, TestSettings.All.Routing.RoadTypicalSpeedKmh.Keys.Order());
        Assert.True(TestSettings.Speeds.Kmh("motorway") > TestSettings.Speeds.Kmh("residential"));
        Assert.Equal(TestSettings.Speeds.Kmh("primary"), TestSettings.Speeds.Kmh("primary_link"));
        Assert.Equal(TestSettings.All.Routing.UnknownRoadSpeedKmh, TestSettings.Speeds.Kmh("not_a_road"));
    }

    [Fact]
    public void Dispatch_capability_names_are_valid_enum_values()
    {
        _ = TestSettings.Responsibilities; // falha ao construir se algum nome não existir
        Assert.All(TestSettings.All.Routing.OffRoadVehicleTypes, t => Assert.True(EnumText.TryParse<VehicleType>(t, out _), t));
    }
}
