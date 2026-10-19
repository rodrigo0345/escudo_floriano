using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Scenarios;

public enum ScenarioPurpose { Planning, Exercise, HistoricalReplay, LiveSupport, Research }
