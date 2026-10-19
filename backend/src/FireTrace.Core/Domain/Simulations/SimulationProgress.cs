using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Simulations;

public sealed record SimulationProgress(string Phase, double Percent, int? MembersDone = null, int? MembersTotal = null, double? EtaSeconds = null);
