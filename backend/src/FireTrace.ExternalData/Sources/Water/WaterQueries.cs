namespace FireTrace.ExternalData.Sources.Water;

/// <summary>As perguntas Overpass dos pontos de água. O texto é a chave da cache em disco, por isso não pode mudar.</summary>
public static class WaterQueries
{
    /// <summary>Hidrantes, tanques, torres de água e piscinas (nós e vias com centro e caixa).</summary>
    public static string Points(string prefix, string bbox) => $@"{prefix}(
nwr[""emergency""~""^(fire_hydrant|water_tank|suction_point|fire_water_pond|fire_water_reservoir|water_point)$""]{bbox};
nwr[""man_made""~""^(water_tower|water_tank|water_well)$""]{bbox};
nwr[""man_made""=""storage_tank""][""content""=""water""]{bbox};
nwr[""amenity""~""^(water_point|drinking_water)$""]{bbox};
nwr[""natural""=""spring""]{bbox};
nwr[""leisure""=""swimming_pool""]{bbox};
);out center bb tags;";

    /// <summary>Lagos, albufeiras e charcas (vias e relações com geometria).</summary>
    public static string Bodies(string prefix, string bbox) => $"{prefix}(way[\"natural\"=\"water\"]{bbox};way[\"landuse\"=\"reservoir\"]{bbox};relation[\"natural\"=\"water\"]{bbox};relation[\"landuse\"=\"reservoir\"]{bbox};);out center geom tags;";
}
