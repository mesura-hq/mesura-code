import * as Schema from "effect/Schema";

export class ServerCliCommandExitError extends Schema.TaggedErrorClass<ServerCliCommandExitError>()(
  "ServerCliCommandExitError",
  {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Command exited with non-zero exit code (${this.exitCode})`;
  }
}

export class ServerCliPublishIconSourceMissingError extends Schema.TaggedErrorClass<ServerCliPublishIconSourceMissingError>()(
  "ServerCliPublishIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing publish icon source: ${this.sourcePath}`;
  }
}

export class ServerCliPublishIconTargetMissingError extends Schema.TaggedErrorClass<ServerCliPublishIconTargetMissingError>()(
  "ServerCliPublishIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing publish icon target: ${this.targetPath}. Run the build subcommand first.`;
  }
}

export class ServerCliDevelopmentIconSourceMissingError extends Schema.TaggedErrorClass<ServerCliDevelopmentIconSourceMissingError>()(
  "ServerCliDevelopmentIconSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon source: ${this.sourcePath}`;
  }
}

export class ServerCliDevelopmentIconTargetMissingError extends Schema.TaggedErrorClass<ServerCliDevelopmentIconTargetMissingError>()(
  "ServerCliDevelopmentIconTargetMissingError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing development icon target: ${this.targetPath}. Build web first.`;
  }
}

export class ServerCliBuildAssetMissingError extends Schema.TaggedErrorClass<ServerCliBuildAssetMissingError>()(
  "ServerCliBuildAssetMissingError",
  {
    assetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing build asset: ${this.assetPath}. Run the build subcommand first.`;
  }
}

export class ServerCliWebClientMissingError extends Schema.TaggedErrorClass<ServerCliWebClientMissingError>()(
  "ServerCliWebClientMissingError",
  {
    webDistPath: Schema.String,
  },
) {
  override get message(): string {
    return [
      `Missing web client build: ${this.webDistPath}.`,
      "Bundling it is what lets the server package serve a UI; without it the package still installs,",
      "starts, and answers its API, while every browser client receives 503 and only the desktop app",
      "keeps working. Build the web app first (vp run --filter @t3tools/web build), or pass",
      "--allow-missing-client to accept a server-only bundle.",
    ].join(" ");
  }
}
