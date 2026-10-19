using FireTrace.Engine.Contracts;
using FireTrace.ExternalData.Map;

namespace FireTrace.Core.Common;

public static class GridSpecExtensions
{
    /// <summary>The engine only needs the raster's size; it knows nothing about georeferencing.</summary>
    public static EngineGrid ToEngineGrid(this GridSpec spec) => new(spec.Width, spec.Height, spec.CellM);
}
