using System.Text.Json;

namespace FireTrace.ExternalData.Sources.Roads;

/// <summary>O troço contínuo de uma via que fica dentro do local.</summary>
public sealed record WayRun(JsonElement Way, List<WayVertex> Points);
