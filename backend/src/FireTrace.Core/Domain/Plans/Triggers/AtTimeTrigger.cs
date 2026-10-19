using System.Text.Json.Serialization;
using System.Text.Json;
using FireTrace.Core.Domain.Common;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Triggers;

public sealed record AtTimeTrigger(TimeSpec At) : Trigger;
