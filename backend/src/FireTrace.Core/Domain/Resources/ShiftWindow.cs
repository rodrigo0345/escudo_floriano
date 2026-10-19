using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

public sealed record ShiftWindow(DateTimeOffset? From = null, DateTimeOffset? To = null);
