using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record VegetationClass(int Id, string Key, string Label, string Color, int FuelModel, int CanopyCoverPct, double CanopyHeightM, double CanopyBaseHeightM, int BurnMinutes, double SharePct);
