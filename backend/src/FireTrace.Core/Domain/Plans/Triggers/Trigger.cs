using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Triggers;

// ----------------------------------------------------------------------------------------------- gatilhos e atribuições de meios
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(AtTimeTrigger), "at_time")]
[JsonDerivedType(typeof(OnFireArrivalTrigger), "on_fire_arrival")]
[JsonDerivedType(typeof(OnWeatherTrigger), "on_weather")]
[JsonDerivedType(typeof(OnActionCompleteTrigger), "on_action_complete")]
[JsonDerivedType(typeof(ManualTrigger), "manual")]
public abstract record Trigger;
