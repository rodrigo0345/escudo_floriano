using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace FireTrace.Core.Controllers.Binding;

/// <summary>Gives an action the <see cref="Query"/> reader of its request: declare a `Query query` parameter and it is there.</summary>
public sealed class QueryBinder : IModelBinder
{
    public Task BindModelAsync(ModelBindingContext bindingContext)
    {
        bindingContext.Result = ModelBindingResult.Success(new Query(bindingContext.HttpContext.Request));
        return Task.CompletedTask;
    }
}
