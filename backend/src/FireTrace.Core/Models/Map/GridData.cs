using System.Runtime.CompilerServices;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Models.Map;

public sealed record GridData(byte[] Bytes, int Width, int Height, double CellM, string DType);
