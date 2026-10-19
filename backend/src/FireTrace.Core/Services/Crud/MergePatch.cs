using System.Text.Json.Nodes;
using System.Text.Json;
using FireTrace.Core.Domain.Errors;
using FireTrace.Core.Serialization;

namespace FireTrace.Core.Services.Crud;

/// <summary>JSON Merge Patch (RFC 7396) aplicado a um recurso.</summary>
public static class MergePatch
{
    public static T Apply<T>(T current, JsonElement patch)
    {
        var target = JsonSerializer.SerializeToNode(current, ApiJson.Options)!;
        if (JsonNode.Parse(patch.GetRawText()) is not JsonObject p) throw new ValidationException("O corpo do PATCH tem de ser um objeto JSON.");
        Merge((JsonObject)target, p);
        try { return target.Deserialize<T>(ApiJson.Options)!; }
        catch (JsonException e) { throw new ValidationException($"Alteração inválida: {e.Message}"); }
    }

    static void Merge(JsonObject target, JsonObject patch)
    {
        foreach (var (key, value) in patch.ToList())
        {
            if (value is null) target.Remove(key);
            else if (value is JsonObject po && target[key] is JsonObject to) Merge(to, po);
            else target[key] = value.DeepClone();
        }
    }
}
