using System.Collections.Concurrent;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Fire;

public sealed record SimulationSummary(string SimulationId, IReadOnlyList<SummaryMilestone> Milestones, SummaryMilestone? Final);
