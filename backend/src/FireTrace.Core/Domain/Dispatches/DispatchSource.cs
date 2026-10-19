using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Dispatches;

public enum DispatchSource { Api, PlanAction, Manual }
