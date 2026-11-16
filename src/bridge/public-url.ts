/** Resolve a Vite public asset directory against the actual hosted page URL. */
export function publicAssetBase(baseUrl: string, directory: string, pageUrl: string): string {
  return new URL(`${baseUrl}${directory}/`, pageUrl).href;
}
