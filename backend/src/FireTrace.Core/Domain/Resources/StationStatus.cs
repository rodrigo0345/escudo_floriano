using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public enum StationStatus { Operational, Degraded, Evacuated, Closed }
