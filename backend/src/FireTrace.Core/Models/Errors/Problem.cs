using System.Reflection;
using System.Text.Json;
using FireTrace.Core.Domain.Errors;
using Microsoft.Extensions.FileProviders;
using Swashbuckle.AspNetCore.SwaggerUI;

namespace FireTrace.Core.Models.Errors;

public sealed record Problem(string Title, int Status, string Code, string Instance, IReadOnlyList<ValidationIssue>? Errors = null, string? RequestId = null, string Type = "about:blank");
