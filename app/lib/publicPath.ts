const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const PUBLIC_BASE_PATH = configuredBasePath.replace(/\/$/, "");

export function publicPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${PUBLIC_BASE_PATH}${normalizedPath}`;
}
