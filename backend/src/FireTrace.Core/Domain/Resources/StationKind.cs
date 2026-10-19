using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

// ----------------------------------------------------------------------------------------------- postos
public enum StationKind { FireStation, GnrPost, PspStation, InemBase, CivilProtectionHq, CommandPost, StagingArea, Helipad, Other }
