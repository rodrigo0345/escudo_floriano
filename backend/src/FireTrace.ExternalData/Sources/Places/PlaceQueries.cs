namespace FireTrace.ExternalData.Sources.Places;

/// <summary>
/// As perguntas Overpass das localidades e instalações. O texto é a chave da cache em disco, por isso não pode mudar: a pergunta dos serviços
/// de emergência é a original e as instalações vulneráveis vão numa pergunta à parte.
/// </summary>
public static class PlaceQueries
{
    public static string Core(string prefix, string bbox) => $@"{prefix}(
node[""place""~""^(city|town|suburb|village|hamlet)$""][""name""]{bbox};
nwr[""amenity""~""^(fire_station|police|hospital|townhall|ambulance_station|clinic|doctors|pharmacy)$""]{bbox};
nwr[""emergency""~""^(ambulance_station|civil_defense|disaster_help|fire_lookout)$""]{bbox};
nwr[""man_made""=""tower""][""tower:type""=""fire_lookout""]{bbox};
);out center tags;";

    public static string Civil(string prefix, string bbox) => $@"{prefix}(
nwr[""amenity""~""^(school|kindergarten|college|university|nursing_home|retirement_home|social_facility|community_centre|fuel)$""]{bbox};
nwr[""healthcare""~""^(centre|clinic|hospital)$""]{bbox};
nwr[""leisure""~""^(sports_hall|sports_centre)$""]{bbox};
nwr[""emergency""=""assembly_point""]{bbox};
nwr[""tourism""~""^(camp_site|caravan_site)$""]{bbox};
nwr[""aeroway""~""^(helipad|heliport)$""]{bbox};
);out center tags;";
}
