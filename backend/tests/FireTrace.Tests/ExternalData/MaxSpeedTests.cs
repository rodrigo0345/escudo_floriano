using FireTrace.ExternalData.Sources.Roads;

namespace FireTrace.Tests.ExternalData;

public class MaxSpeedTests
{
    [Theory]
    [InlineData("50", 50)]
    [InlineData(" 90 km/h ", 90)]
    [InlineData("30 mph", 48.3)]
    [InlineData("walk", 7)]
    [InlineData("50;30", 30)]
    public void Numeric_limits_are_read_in_kmh(string tag, double expected) => Assert.Equal(expected, OsmMaxSpeed.Parse(tag));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("none")]
    [InlineData("signals")]
    [InlineData("PT:urban")]
    [InlineData("500")]
    [InlineData("50;PT:rural")]
    public void Missing_symbolic_or_absurd_limits_are_unknown(string? tag) => Assert.Null(OsmMaxSpeed.Parse(tag));
}
