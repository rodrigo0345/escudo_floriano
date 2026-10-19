using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record VegetationInfo(string LocationId, IReadOnlyList<VegetationClass> Classes, string Method, string Caveat, string GridUrl);
