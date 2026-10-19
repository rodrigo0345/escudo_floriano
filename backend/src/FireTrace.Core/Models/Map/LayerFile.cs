using System.Runtime.CompilerServices;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record LayerFile(string? Path, byte[]? Bytes, string MediaType);
