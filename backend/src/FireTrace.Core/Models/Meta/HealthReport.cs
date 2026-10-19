namespace FireTrace.Core.Models.Meta;

/// <summary>`GET /health`: the server is `ok` when the database and the engine answer, `degraded` otherwise.</summary>
public sealed record HealthReport(string Status, string? Version, IReadOnlyList<string> Modules, HealthEngine Engine, string Database, IReadOnlyList<string> Locations);
