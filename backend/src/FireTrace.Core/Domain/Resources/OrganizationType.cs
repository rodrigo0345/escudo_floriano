using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

// Os meios de cada organização: quem são, onde estão, o que têm e o que estão a fazer. Os nomes seguem o contrato (`api/openapi.json`).

public enum OrganizationType { FireBrigade, Gnr, Psp, Inem, CivilProtection, Municipality, ForestService, AirForce, Other }
