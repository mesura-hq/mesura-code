export const browserApiCorsAllowedMethods = [
  "GET",
  "HEAD",
  "POST",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "tus-resumable",
  "upload-length",
  "upload-metadata",
  "upload-offset",
] as const;

export const browserApiCorsExposedHeaders = [
  "location",
  "tus-extension",
  "tus-resumable",
  "tus-version",
  "upload-length",
  "upload-offset",
] as const;

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;
