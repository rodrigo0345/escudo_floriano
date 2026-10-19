using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record VegetationAt(int Id, string Key, string Label, int FuelModel);
