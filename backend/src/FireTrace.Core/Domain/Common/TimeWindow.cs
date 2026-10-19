using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Common;

public sealed record TimeWindow(TimeSpec Start, TimeSpec End);
