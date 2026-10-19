using System.Text.Json;
using System.Text.RegularExpressions;
using FireTrace.ExternalData.Configuration;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Overpass;

namespace FireTrace.ExternalData.Sources.Places;

public static class FacilityClassifier
{
    /// <summary>Tipo de instalação a partir das etiquetas: (tipo, vulnerável, confiança) ou nada se não interessa.</summary>
    public static (FacilityKind Kind, bool Vulnerable, double Confidence)? Classify(JsonElement el, string? name, PlaceConfidence c)
    {
        string? amenity = OsmJson.Tag(el, "amenity"), op = OsmJson.Tag(el, "operator"), emergency = OsmJson.Tag(el, "emergency"), aeroway = OsmJson.Tag(el, "aeroway");
        string? healthcare = OsmJson.Tag(el, "healthcare");
        if (amenity == "fire_station" || emergency == "fire_lookout" || OsmJson.Tag(el, "tower:type") == "fire_lookout") return (FacilityKind.FireStation, false, c.Emergency);
        if (amenity == "hospital" || healthcare == "hospital") return (FacilityKind.Hospital, true, c.Emergency);
        if (amenity is "clinic" or "doctors" or "pharmacy" || healthcare is "centre" or "clinic") return (FacilityKind.HealthCentre, true, c.Emergency);
        if (aeroway is "helipad" or "heliport") return (FacilityKind.Heliport, false, c.Emergency);
        if (emergency is "civil_defense" or "disaster_help" || Regex.IsMatch($"{op} {name}", @"Prote[çc][ãa]o\s+Civil", RegexOptions.IgnoreCase)) return (FacilityKind.CivilProtection, false, c.Emergency);
        if (amenity == "townhall") return (FacilityKind.TownHall, false, name is not null && name.StartsWith("Câmara Municipal", StringComparison.OrdinalIgnoreCase) ? c.Emergency : c.AssemblyPoint);
        if (amenity == "ambulance_station" || emergency == "ambulance_station") return (FacilityKind.Inem, false, c.Emergency);
        if (amenity == "police") return Regex.IsMatch($"{op} {name}", "GNR|Guarda Nacional", RegexOptions.IgnoreCase) ? (FacilityKind.Gnr, false, c.Emergency) : (FacilityKind.Psp, false, c.Police);
        if (amenity is "school" or "kindergarten" or "college" or "university") return (FacilityKind.School, true, c.Education);
        if (amenity is "nursing_home" or "retirement_home" || (amenity == "social_facility" && OsmJson.Tag(el, "social_facility") is "nursing_home" or "assisted_living" or "group_home")) return (FacilityKind.CareHome, true, c.CareHome);
        if (amenity == "fuel") return (FacilityKind.FuelStation, false, c.Fuel);
        if (OsmJson.Tag(el, "tourism") is "camp_site" or "caravan_site") return (FacilityKind.CampSite, true, c.CampSite);
        if (emergency == "assembly_point") return (FacilityKind.Shelter, false, c.AssemblyPoint);
        if (amenity == "community_centre" || OsmJson.Tag(el, "leisure") is "sports_hall" or "sports_centre") return (FacilityKind.Shelter, false, c.SportsHall);
        return null;
    }
}
