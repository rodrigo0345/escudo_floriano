using System.Text.Json.Serialization;
using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Plans.Actions;

// ----------------------------------------------------------------------------------------------- ações
public enum ActionStatus { Planned, Acknowledged, InProgress, Completed, Failed, Cancelled, Blocked }
