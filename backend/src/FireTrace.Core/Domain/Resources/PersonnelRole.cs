using System.Text.Json;
using NetTopologySuite.Geometries;

namespace FireTrace.Core.Domain.Resources;

// ----------------------------------------------------------------------------------------------- pessoal e equipamento
public enum PersonnelRole
{
    Firefighter, ForestFirefighter, CrewLeader, Officer, Commander, Paramedic, EmergencyPhysician, Nurse, PoliceOfficer, GnrSoldier, TrafficOfficer,
    RescueSpecialist, DronePilot, DriverOperator, CommsOperator, CivilProtectionTechnician, Volunteer, Other,
}
