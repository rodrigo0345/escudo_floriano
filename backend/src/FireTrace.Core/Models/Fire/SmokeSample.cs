using System.Collections.Concurrent;

namespace FireTrace.Core.Models.Fire;

public sealed record SmokeSample(int TMin, double ConcentrationUgm3, double VisibilityM, int VisibilityClass, bool SafeForGroundOperations, bool SafeForAerialOperations);
