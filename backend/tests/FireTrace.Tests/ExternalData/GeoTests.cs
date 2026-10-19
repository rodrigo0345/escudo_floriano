using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.ExternalData.Sources.Projection;

namespace FireTrace.Tests.ExternalData;

public class GeoTests
{
    [Fact]
    public void Grid_coordinates_round_trip()
    {
        var s = new GridSpec(41.438, -8.283, 140, 140, 60);
        var (x, y) = s.ToCell(41.43, -8.27);
        var (lat, lon) = s.ToLatLon(x, y);
        Assert.Equal(41.43, lat, 8); Assert.Equal(-8.27, lon, 8);
        Assert.True(s.Inside(70, 70)); Assert.False(s.Inside(-2, 5));
        Assert.True(s.CellAt(41.438, -8.283) >= 0); Assert.Equal(-1, s.CellAt(45, -8.283));
    }

    [Fact]
    public void Location_files_are_extensible_by_dropping_a_json_file()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        File.WriteAllText(Path.Combine(dir, "outro.json"), "{ /* comentário */ \"name\": \"Outro local\", \"center\": {\"lat\": 40.2, \"lon\": -8.4}, \"widthCells\": 50, \"heightCells\": 60 }");
        var l = LocationCatalog.FromDirectory(dir).All.Single();
        Assert.Equal("outro", l.Id);                  // o id vem do nome do ficheiro
        Assert.Equal(40.2, l.WeatherPoint.Lat);       // ponto meteorológico por omissão = centro
        Assert.Equal(60, l.Spec.Height);
    }

    [Fact]
    public void Utm_matches_a_known_point()
    {
        var (x, y) = UtmProjection.Project(41.4425, -8.2918, 29); // Guimarães, zona 29
        Assert.InRange(x, 555_000, 565_000); Assert.InRange(y, 4_583_000, 4_593_000);
    }
}
