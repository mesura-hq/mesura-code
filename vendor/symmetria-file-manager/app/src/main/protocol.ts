import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveMimeType } from "@symmetria/fm-core/mime";
import { containedRealPath } from "@symmetria/fm-main/appPath";
import { mimeTables } from "@symmetria/fm-main/fs/mimeTables";
import {
  resolvePreviewDirectoryPath,
  resolveToken,
  TOKEN_PREFIX,
} from "@symmetria/fm-main/previewTokens";
import { net, protocol } from "electron";

import { APP_SCHEME } from "./appScheme.ts";

import { fileResponse } from "./fileResponse.ts";

/**
 * The scheme the renderer is served from.
 *
 * NOT `file://`, and that is the whole point of this module. Verification of
 * phase 2 found that a page loaded with `loadFile` sits on a `file://` origin,
 * and Chromium lets a `file://` page read any other `file://` resource with
 * plain `fetch` or `XMLHttpRequest`. `sandbox: true` does not close that;
 * neither does `webSecurity: true`, because it is not a CORS problem in
 * Chromium's file-scheme model. `require("node:fs")` was blocked and the
 * filesystem was reachable anyway — `fetch("file:///etc/passwd")` returned
 * 2088 bytes.
 *
 * Giving the page its own origin closes it: a `symmetria-fm://` document has no
 * privilege over `file://` resources, so the only route to the disk becomes the
 * bridge, which is what the architecture assumes everywhere else.
 */
// The value itself lives in `appScheme.ts`, which imports no Electron and so
// can be read by `frameNavigation.ts`, which must stay testable.

/** The authority segment. `symmetria-fm://app/index.html`. */
const APP_HOST = "app";

/**
 * Must run before the app is ready, and before any window exists.
 *
 * `standard` gives the scheme normal URL parsing so relative asset paths work.
 * `secure` puts it in a secure context, which the platform requires for several
 * APIs. `supportFetchAPI` lets page code fetch its own assets. None of these
 * grants any access to `file://`.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/** The directory the built renderer lives in. */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer/", import.meta.url));
}

const notFound = () => new Response("not found", { status: 404 });

/**
 * A previewed file, addressed by a token the main process issued.
 *
 * Served from this scheme rather than as a blob URL because Chromium's PDF
 * viewer refuses a blob whose origin is a custom scheme — the embed resolves to
 * an error page, invisibly. It also saves copying the file across the process
 * boundary.
 */
/**
 * The type to declare for a previewed file.
 *
 * From the SAME database every other part of this application resolves a type
 * with, rather than from a second guess of our own. `net.fetch` used to supply
 * this by sniffing the extension itself, and letting two different resolvers
 * answer the same question about the same file is how they come to disagree.
 */
async function contentTypeOf(path: string): Promise<string> {
  return resolveMimeType(await mimeTables(), basename(path)) ?? "application/octet-stream";
}

/**
 * A previewed file, addressed by a token the main process issued.
 *
 * Served from this scheme rather than as a blob URL because Chromium's PDF
 * viewer refuses a blob whose origin is a custom scheme — the embed resolves to
 * an error page, invisibly. It also saves copying the file across the process
 * boundary.
 *
 * **It answers byte ranges, and that is not an optimisation.** `net.fetch` on a
 * `file://` URL returns a body with no `content-length` and no `accept-ranges`,
 * which every previous consumer ignored and a media element will not: measured,
 * a valid H.264 file served that way raises `MEDIA_ELEMENT_ERROR: Format
 * error`, indistinguishable from a corrupt one. See `fileRange.ts`.
 */
async function servePreview(request: Request, pathname: string): Promise<Response> {
  const previewed = resolveToken(pathname.slice(TOKEN_PREFIX.length));
  // A token that was never issued, or was evicted. Not found is the honest
  // answer: this route reaches exactly what the main process handed out.
  if (previewed === null) return notFound();

  // A token can outlive the file it names — the user deletes it, or a download
  // finishes into a different name — and a `stat` that throws inside a protocol
  // handler surfaces as a dead page rather than as a status.
  const size = await stat(previewed)
    .then((stats) => stats.size)
    .catch(() => null);
  if (size === null) return notFound();

  const contentType = await contentTypeOf(previewed);
  return fileResponse(previewed, size, contentType, request.headers.get("range"));
}

/**
 * A neighbour of a previewed document, addressed under its directory grant.
 *
 * The address is `<token>/<relative path>`, and the two halves are checked by
 * different things: the token says which directory was granted, and
 * `resolvePreviewDirectoryPath` says whether the relative path stays inside it
 * once symbolic links are followed. It answers `null` for an escape, a
 * malformed percent-sequence, a NUL byte and an absent file alike, which is
 * why there is one status here and not four.
 *
 * This is what makes a rendered markdown file show the diagram beside it and a
 * rendered page load its own stylesheet. Without it a relative reference
 * resolves against the token URL, finds nothing, and both render stripped of
 * their own assets.
 */
async function serveNeighbour(
  request: Request,
  token: string,
  relative: string,
): Promise<Response> {
  const file = await resolvePreviewDirectoryPath(token, relative);
  if (file === null) return notFound();

  const size = await stat(file)
    .then((stats) => stats.size)
    .catch(() => null);
  if (size === null) return notFound();

  return fileResponse(file, size, await contentTypeOf(file), request.headers.get("range"));
}

/**
 * One of the page's own assets.
 *
 * One gate, not two. An `access()` check before the read would add a syscall
 * and a window between the check and the use; letting the fetch itself fail is
 * both simpler and race-free.
 */
async function serveAsset(root: string, pathname: string): Promise<Response> {
  const file = await containedRealPath(root, pathname);
  if (file === null) return notFound();

  return net.fetch(pathToFileURL(file).toString());
}

export function handleAppScheme(): void {
  const root = rendererRoot();

  // Four branches and nothing else: wrong host, a document's neighbour, a
  // preview token, or an asset. Each route is a function rather than a block
  // because they answer different questions with different failure modes — and
  // because as one body this handler sat exactly on the project's change-risk
  // bound.
  //
  // **A slash is the whole discriminator between the two token routes.** A file
  // grant is addressed as `<prefix><token>` with nothing after it; a directory
  // grant is addressed as `<prefix><token>/<relative path>`. So the presence of
  // a separator in the remainder says which kind of grant is being used, and
  // the two token maps are separate precisely so a token cannot be mistaken for
  // the other kind even if this test were ever wrong.
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) return notFound();

    if (url.pathname.startsWith(TOKEN_PREFIX)) {
      const remainder = url.pathname.slice(TOKEN_PREFIX.length);
      const separator = remainder.indexOf("/");
      if (separator < 0) return servePreview(request, url.pathname);

      return serveNeighbour(request, remainder.slice(0, separator), remainder.slice(separator + 1));
    }

    return serveAsset(root, url.pathname);
  });
}

/** The URL the window loads. */
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** Where a token-addressed preview is served from. */
export function previewUrlFor(token: string): string {
  return `${APP_SCHEME}://${APP_HOST}${TOKEN_PREFIX}${token}`;
}
