using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans;

// ----------------------------------------------------------------------------------------------- planos
public enum PlanStatus { Proposed, Selected, Active, Completed, Discarded, Cancelled }
