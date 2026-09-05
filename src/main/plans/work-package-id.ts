/** Return the human-briefed id from a database id minted for a plan package. */
export function briefedWorkPackageId(packageId: string, planArtifactId: string): string {
  const mintedPrefix = `wp:${planArtifactId}:`;
  return packageId.startsWith(mintedPrefix) ? packageId.slice(mintedPrefix.length) : packageId;
}
