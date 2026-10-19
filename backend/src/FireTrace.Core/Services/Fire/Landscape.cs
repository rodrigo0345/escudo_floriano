using FireTrace.Core.Services.Fire;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Services.Fire;

/// <summary>A paisagem de um local pronta para o motor.</summary>
public sealed record Landscape(short[] Bands, float[] Adjustment, BarrierSet Barriers);
