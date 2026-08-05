export function shouldSyncDestinationUrl(
  previousDestinationUrl: string,
  destinationUrl: string,
  loadedUrl: string | undefined,
): boolean {
  return destinationUrl !== ''
    && destinationUrl !== previousDestinationUrl
    && loadedUrl !== destinationUrl;
}
