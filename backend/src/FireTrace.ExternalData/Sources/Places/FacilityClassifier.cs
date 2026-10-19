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
        string? amenity = OsmJson.Tag(el, "amenity"), op = OsmJson.Tag(el, "operator");
        if (amenity == "fire_station") return (FacilityKind.FireStation, false, c.Emergency);
        if (amenity == "hospital") return (FacilityKind.Hospital, true, c.Emergency);
        if (amenity == "townhall") return name is not null && name.StartsWith("Câmara Municipal", StringComparison.OrdinalIgnoreCase) ? (FacilityKind.TownHall, false, c.Emergency) : null;
        if (amenity == "ambulance_station" || OsmJson.Tag(el, "emergency") == "ambulance_station") return (FacilityKind.Inem, false, c.Emergency);
        if (amenity == "police") return Regex.IsMatch($"{op} {name}", "GNR|Guarda Nacional", RegexOptions.IgnoreCase) ? (FacilityKind.Gnr, false, c.Emergency) : (FacilityKind.Psp, false, c.Police);
        if (amenity is "school" or "kindergarten" or "college") return (FacilityKind.School, true, c.Education);
        if (amenity is "nursing_home" or "retirement_home" || (amenity == "social_facility" && OsmJson.Tag(el, "social_facility") is "nursing_home" or "assisted_living" or "group_home")) return (FacilityKind.CareHome, true, c.CareHome);
        if (amenity == "fuel") return (FacilityKind.FuelStation, false, c.Fuel);
        if (OsmJson.Tag(el, "tourism") == "camp_site") return (FacilityKind.CampSite, true, c.CampSite);
        if (OsmJson.Tag(el, "emergency") == "assembly_point") return (FacilityKind.Shelter, false, c.AssemblyPoint);
        if (amenity == "community_centre" || OsmJson.Tag(el, "leisure") == "sports_hall") return (FacilityKind.Shelter, false, c.SportsHall); // pavilhões servem de abrigo, mas não há garantia
        return null;
    }
}
