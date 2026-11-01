import path from 'node:path';
import { appHost } from '../app.js';

// Maps a `wow://app/...` request to a file of the built web app. Paths without an extension are
// router paths and get index.html, as a single-page app server would. Anything that would leave
// the renderer directory, or names another host, gets nothing.
export function rendererFile(rendererDir: string, requestUrl: string): string | undefined {
  let url: URL;
  let pathname: string;
  try {
    url = new URL(requestUrl);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  // A backslash is a separator on Windows only; no file of the web app has one in its name.
  if (url.host !== appHost || pathname.includes('\\')) return undefined;
  const root = path.resolve(rendererDir);
  if (path.posix.extname(pathname) === '') return path.join(root, 'index.html');
  const file = path.resolve(root, `.${path.posix.normalize(pathname)}`);
  return file.startsWith(root + path.sep) ? file : undefined;
}
