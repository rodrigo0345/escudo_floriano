using FireTrace.Core.Configuration;
using FireTrace.Core.Models.Paging;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace FireTrace.Core.Controllers.Binding;

/// <summary>Registers the binders of the query-string helpers (`Query`, `PageQuery`) with MVC.</summary>
public sealed class QueryModelBinderProvider : IModelBinderProvider
{
    public IModelBinder? GetBinder(ModelBinderProviderContext context)
    {
        var type = context.Metadata.ModelType;
        if (type == typeof(Query)) return new QueryBinder();
        if (type == typeof(PageQuery))
            return new PageQueryBinder(context.Services.GetRequiredService<DefaultsSettings>(), context.Services.GetRequiredService<LimitsSettings>());
        return null;
    }
}
