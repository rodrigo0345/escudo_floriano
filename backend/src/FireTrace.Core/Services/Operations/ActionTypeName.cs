using System.Reflection;
using System.Text.Json.Serialization;
using FireTrace.Core.Domain.Plans.Actions;

namespace FireTrace.Core.Services.Operations;

/// <summary>The value of `type` an action is written with in JSON (it comes from the polymorphism attribute on <see cref="PlanAction"/>).</summary>
public static class ActionTypeName
{
    public static string Of(PlanAction action) =>
        typeof(PlanAction).GetCustomAttributes<JsonDerivedTypeAttribute>().First(t => t.DerivedType == action.GetType()).TypeDiscriminator?.ToString() ?? "custom";
}
