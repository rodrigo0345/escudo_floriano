namespace FireTrace.ExternalData.Map;

/// <summary>Definição declarativa de um local; adicionar um local = adicionar um ficheiro locations/&lt;id&gt;.json.</summary>
public sealed class LocationDefinition
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public LatLon Center { get; set; } = new(0, 0);
    public int WidthCells { get; set; } = 140;
    public int HeightCells { get; set; } = 140;
    public double CellM { get; set; } = 60;
    public double RenderCellM { get; set; } = 20;
    public LatLon WeatherPoint { get; set; } = new(0, 0);
    public int ImageryZoom { get; set; } = 15;
    public int ImageryPixels { get; set; } = 3072;
    /// <summary>Ortofotos de alta resolução (DGT, Portugal): nº de blocos por lado (0 = desligado) e píxeis por bloco. 2×3072 ≈ 1,4 m/píxel em 8 km.</summary>
    public int OrthoTiles { get; set; } = 0;
    public int OrthoTilePixels { get; set; } = 3072;
    /// <summary>Este local usa a cidade 3D (tiles em `data/tiles3d/&lt;id&gt;/`, ver `tools/fetch_tiles3d.py`): o ingest avisa se faltarem.</summary>
    public bool Tiles3d { get; set; } = false;
    public string LandCoverSource { get; set; } = "worldcover-2021";
    /// <summary>Ano das imagens Sentinel-2 usadas para a fenologia (inverno jan–fev, verão jul–ago).</summary>
    public int PhenologyYear { get; set; } = 2025;
    public List<CuratedFacility> CuratedFacilities { get; set; } = new();
    public List<ScenarioSeed> Incidents { get; set; } = new();

    public GridSpec Spec => new(Center.Lat, Center.Lon, WidthCells, HeightCells, CellM);
    public GridSpec RenderSpec => new(Center.Lat, Center.Lon, (int)Math.Round(WidthCells * CellM / RenderCellM), (int)Math.Round(HeightCells * CellM / RenderCellM), RenderCellM);
}
