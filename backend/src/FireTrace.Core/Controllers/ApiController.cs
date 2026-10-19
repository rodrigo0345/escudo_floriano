using System.Globalization;
using FireTrace.Core.Models.Map;

namespace FireTrace.Core.Controllers;

/// <summary>Base of every controller: JSON in/out under `/api/v1`. Controllers only translate HTTP to one service call and back.</summary>
[ApiController]
public abstract class ApiController : ControllerBase
{
    public const string Base = "/api/v1";

    /// <summary>A raw raster as `application/octet-stream`; its size, cell size and element type go in the `X-Grid-*` headers.</summary>
    protected FileContentResult GridFile(GridData grid)
    {
        Response.Headers["X-Grid-Width"] = grid.Width.ToString(CultureInfo.InvariantCulture);
        Response.Headers["X-Grid-Height"] = grid.Height.ToString(CultureInfo.InvariantCulture);
        Response.Headers["X-Grid-Cell-M"] = grid.CellM.ToString(CultureInfo.InvariantCulture);
        Response.Headers["X-Grid-Dtype"] = grid.DType;
        return File(grid.Bytes, "application/octet-stream");
    }
}
