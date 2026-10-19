using FireTrace.Core.Configuration;
using FireTrace.Core.Models.Paging;
using FireTrace.ExternalData.Store;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace FireTrace.Core.Controllers.Binding;

/// <summary>`limit`, `cursor` e `updatedAfter`; o tamanho por omissão e o máximo vêm de `FireTrace:Defaults` e `FireTrace:Limits`.</summary>
public sealed class PageQueryBinder(DefaultsSettings defaults, LimitsSettings limits) : IModelBinder
{
    public Task BindModelAsync(ModelBindingContext bindingContext)
    {
        var query = new Query(bindingContext.HttpContext.Request);
        var page = new PageQuery(Math.Clamp(query.Int("limit") ?? defaults.PageSize, 1, limits.MaxPageSize), query.Str("cursor"), query.Time("updatedAfter"));
        bindingContext.Result = ModelBindingResult.Success(page);
        return Task.CompletedTask;
    }
}
