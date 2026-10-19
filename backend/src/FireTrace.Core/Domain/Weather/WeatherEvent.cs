using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Weather;

/// <summary>Alteração programada sobre a série base. Aplicam-se pela ordem em que aparecem.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(WindShiftEvent), "wind_shift")]
[JsonDerivedType(typeof(WindScaleEvent), "wind_scale")]
[JsonDerivedType(typeof(WindSetEvent), "wind_set")]
[JsonDerivedType(typeof(GustBurstEvent), "gust_burst")]
[JsonDerivedType(typeof(FrontPassageEvent), "front_passage")]
[JsonDerivedType(typeof(TemperatureShiftEvent), "temperature_shift")]
[JsonDerivedType(typeof(HumidityShiftEvent), "humidity_shift")]
[JsonDerivedType(typeof(PrecipitationEvent), "precipitation")]
[JsonDerivedType(typeof(CustomSeriesEvent), "custom_series")]
public abstract record WeatherEvent
{
    public string? Id { get; init; }
    public string? Label { get; init; }
    public bool Enabled { get; init; } = true;
}
