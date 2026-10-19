using System.Text.Json.Serialization;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record CountBreakdown(string Key, int Total, int Available);
